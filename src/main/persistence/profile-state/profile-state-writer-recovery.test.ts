import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot
} from '../../crash-reporting/crash-breadcrumb-store'
import { TEST_LEAF_1 } from '../../persistence-session-fixtures'
import { createRecoveryFixture } from './profile-state-writer-recovery-fixture'
import { PROFILE_STATE_WRITER_RECOVERY_LIMIT } from './profile-state-writer-supervisor'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const marker = (value: string) => [{ domain: 'ui', payload: JSON.stringify({ marker: value }) }]

function recoveryBreadcrumbs() {
  return getCrashBreadcrumbSnapshot()
    .filter((crumb) => crumb.name.startsWith('profile_state_writer'))
    .map((crumb) => ({ name: crumb.name, ...crumb.data }))
}

beforeEach(() => clearCrashBreadcrumbsForTest())

describe('profile state writer recovery', () => {
  it('replays a write whose worker hung before it could commit', async () => {
    const { authority, onFailure, readMeta, readState, instances, log } =
      await createRecoveryFixture([{ hangWrite: 1 }])
    const before = readMeta().revision

    await expect(authority.writeSerializedDomains(marker('replayed'))).resolves.toBeUndefined()

    expect(readMeta().revision).toBe(before + 1)
    expect(readState().ui.marker).toBe('replayed')
    expect(instances()).toBe(2)
    expect(log()).toEqual(['0:write-domains', '0:hung', '1:write-domains'])
    await authority.writeSerializedDomains(marker('after'))
    expect(readMeta().revision).toBe(before + 2)
    expect(onFailure).not.toHaveBeenCalled()
    expect(recoveryBreadcrumbs()).toEqual([
      expect.objectContaining({
        name: 'profile_state_writer_timeout',
        command: 'write-domains',
        acknowledgedRevision: before,
        timeoutMs: 1_500
      }),
      expect.objectContaining({ name: 'profile_state_writer_recovery', result: 'started' }),
      expect.objectContaining({
        name: 'profile_state_writer_recovery',
        result: 'succeeded',
        committed: false,
        interruptedCommand: 'write-domains'
      })
    ])
  })

  it('adopts a write that committed before its acknowledgement was lost, without replaying it', async () => {
    const { authority, onFailure, readMeta, readState, log } = await createRecoveryFixture([
      { dropReplyOfWrite: 1 }
    ])
    const before = readMeta().revision

    await expect(authority.writeSerializedDomains(marker('committed'))).resolves.toBeUndefined()

    expect(readMeta()).toEqual({
      revision: before + 1,
      operationId: expect.stringMatching(/^[0-9a-f-]{36}:1$/)
    })
    expect(readState().ui.marker).toBe('committed')
    // The replacement received no write: the commit was adopted, not duplicated.
    expect(log()).toEqual(['0:write-domains', '0:dropped'])
    await authority.writeSerializedDomains(marker('next'))
    expect(readMeta().revision).toBe(before + 2)
    expect(onFailure).not.toHaveBeenCalled()
    expect(recoveryBreadcrumbs()).toContainEqual(
      expect.objectContaining({ result: 'succeeded', committed: true })
    )
  })

  it('ignores the old worker reply delivered after its on-time timeout and adopts the commit', async () => {
    const { authority, onFailure, readMeta, awaitQueuedReplies, log } = await createRecoveryFixture(
      [],
      { timeoutMs: 30_000 }
    )
    const before = readMeta().revision
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const write = authority.writeSerializedDomains(marker('late'))
    // The reply is queued; the timeout fires first and on time, so no grace applies.
    awaitQueuedReplies(2)
    vi.advanceTimersByTime(30_000)
    await expect(write).resolves.toBeUndefined()
    expect(readMeta().revision).toBe(before + 1)
    expect(log()).toEqual(['0:write-domains'])
    vi.useRealTimers()
    await authority.writeSerializedDomains(marker('next'))
    expect(readMeta().revision).toBe(before + 2)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('refuses recovery when another writer changed the database, and reports once', async () => {
    const { authority, onFailure, readMeta, readState, peer, instances } =
      await createRecoveryFixture([{ hangWrite: 1 }])
    const before = readMeta().revision
    const write = authority.writeSerializedDomains(marker('ours'))
    const other = peer()
    other.writeSerializedDomains([{ domain: 'ui', payload: '{"marker":"theirs"}' }])
    other.close()

    await expect(write).rejects.toMatchObject({
      code: 'profile-state-writer-recovery-failed',
      // Our write cannot be proven absent once a foreign revision exists.
      outcome: 'indeterminate',
      cause: expect.objectContaining({ code: 'profile-state-revision-conflict' })
    })
    expect(readMeta().revision).toBe(before + 1)
    expect(readState().ui.marker).toBe('theirs')
    expect(instances()).toBe(2)
    expect(onFailure).toHaveBeenCalledOnce()
    expect(() => authority.assertWritable()).toThrow('could not be safely restarted')
    await expect(authority.writeSerializedDomains(marker('later'))).rejects.toMatchObject({
      code: 'profile-state-writer-recovery-failed'
    })
    expect(onFailure).toHaveBeenCalledOnce()
    expect(recoveryBreadcrumbs()).toContainEqual(
      expect.objectContaining({
        result: 'refused',
        reason: 'replacement-refused',
        errorCode: 'profile-state-revision-conflict'
      })
    )
  })

  it('shares one replacement between the interrupted caller and the eager failure handler', async () => {
    const { authority, instances, readMeta } = await createRecoveryFixture([{ hangWrite: 1 }])
    const before = readMeta().revision
    const write = authority.writeSerializedDomains(marker('shared'))
    // Waiters during recovery are admitted rather than refused.
    await vi.waitFor(() => expect(instances()).toBe(2), { timeout: 5_000 })
    expect(() => authority.assertWritable()).not.toThrow()
    await write
    await authority.assertCurrentRevision()
    expect(instances()).toBe(2)
    expect(readMeta().revision).toBe(before + 1)
  })

  it('recovers eagerly after an idle worker exits, without alerting', async () => {
    const { authority, onFailure, readMeta, instances } = await createRecoveryFixture([
      { exitAfterWrite: 1 }
    ])
    const before = readMeta().revision
    await authority.writeSerializedDomains(marker('first'))
    await vi.waitFor(() => expect(instances()).toBe(2), { timeout: 5_000 })
    await authority.writeSerializedDomains(marker('second'))
    expect(readMeta().revision).toBe(before + 2)
    expect(onFailure).not.toHaveBeenCalled()
    expect(recoveryBreadcrumbs()).toContainEqual(
      expect.objectContaining({ name: 'profile_state_writer_failed', exitCode: 1 })
    )
  })

  it('stops once, with the write unresolved, when the replacement cannot start', async () => {
    const { authority, onFailure, instances } = await createRecoveryFixture([
      { hangWrite: 1 },
      { failStart: true }
    ])
    await expect(authority.writeSerializedDomains(marker('lost'))).rejects.toMatchObject({
      code: 'profile-state-writer-recovery-failed',
      outcome: 'indeterminate'
    })
    expect(instances()).toBe(2)
    expect(onFailure).toHaveBeenCalledOnce()
    expect(() => authority.assertWritable()).toThrow()
  })

  it('bounds repeated failures and alerts once', async () => {
    const plan = Array.from({ length: PROFILE_STATE_WRITER_RECOVERY_LIMIT + 1 }, () => ({
      hangWrite: 1
    }))
    const { authority, onFailure, instances, readMeta } = await createRecoveryFixture(plan)
    const before = readMeta().revision
    await expect(authority.writeSerializedDomains(marker('stuck'))).rejects.toMatchObject({
      code: 'profile-state-writer-recovery-limit'
    })
    expect(instances()).toBe(PROFILE_STATE_WRITER_RECOVERY_LIMIT + 1)
    expect(readMeta().revision).toBe(before)
    expect(onFailure).toHaveBeenCalledOnce()
  })

  it('does not install a replacement once close begins during recovery', async () => {
    const { authority, onFailure, readMeta, log, instances } = await createRecoveryFixture([
      { hangWrite: 1 },
      { startDelayMs: 300 }
    ])
    const before = readMeta().revision
    const write = authority.writeSerializedDomains(marker('during-close'))
    await vi.waitFor(() => expect(log()).toContain('0:hung'))
    // The replacement has started (its initialization is delayed), so it can prove disk state.
    await vi.waitFor(() => expect(instances()).toBe(2), { timeout: 5_000 })
    await authority.close()
    // The replacement proved disk unchanged, so the caller may safely roll back.
    await expect(write).rejects.toMatchObject({
      code: 'profile-state-writer-closed',
      outcome: 'known-failure'
    })
    expect(readMeta().revision).toBe(before)
    expect(log().filter((line) => line.startsWith('1:'))).toEqual(['1:close'])
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('pauses and resumes maintenance on the recovered writer', async () => {
    const { authority, onFailure, readMeta } = await createRecoveryFixture([
      { dropReplyOfWrite: 1 }
    ])
    const before = readMeta().revision
    await authority.writeSerializedDomains(marker('recovered'))
    const maintenance = await authority.pauseForMaintenance()
    await maintenance.resume()
    await authority.writeSerializedDomains(marker('resumed'))
    expect(readMeta().revision).toBe(before + 2)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('keeps diagnostics free of profile payloads', async () => {
    const { authority } = await createRecoveryFixture([{ hangWrite: 1 }])
    await authority.writeSerializedDomains(marker('secret-terminal-text'))
    const serialized = JSON.stringify(getCrashBreadcrumbSnapshot())
    expect(serialized).not.toContain('secret-terminal-text')
    expect(serialized).not.toContain('recovery-test')
    expect(serialized).not.toContain('profile-state.db')
  })
})

describe('Store saving across writer recovery', () => {
  const binding = {
    worktreeId: 'repo-local::/fixture/local',
    tabId: 'recovered-binding-tab',
    leafId: TEST_LEAF_1,
    ptyId: 'recovered-binding-pty',
    incarnationId: 'recovered-binding-incarnation'
  }

  it('saves a terminal pane binding whose write was interrupted, without a restart', async () => {
    const { store, readState, onFailure } = await createRecoveryFixture([{ hangWrite: 1 }], {
      withStore: true
    })
    await expect(store!.persistPtyBinding(binding)).resolves.toBe(true)
    expect(
      readState().workspaceSession.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId
    ).toEqual({ [binding.leafId]: binding.ptyId })
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('keeps edits made during recovery and satisfies their durability waiters', async () => {
    const { store, readState, log } = await createRecoveryFixture([{ dropReplyOfWrite: 1 }], {
      withStore: true
    })
    const first = store!.persistPtyBinding(binding)
    await vi.waitFor(() => expect(log()).toContain('0:dropped'))
    store!.updateSettings({ theme: 'dark' })
    const flushed = store!.flushPendingOrThrowAsync()
    await expect(first).resolves.toBe(true)
    await flushed
    const state = readState()
    expect(state.settings.theme).toBe('dark')
    expect(state.workspaceSession.terminalLayoutsByTabId[binding.tabId]).toBeDefined()
  })
})
