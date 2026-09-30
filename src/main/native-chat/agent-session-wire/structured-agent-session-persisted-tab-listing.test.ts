// A restarted host lists a chat's tab from its record and the tab table, never from whether its
// history opened: a chat with no history on disk, and one whose history cannot be read, both keep
// their tab.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { closeTestJournalHostDatabases } from '../agent-session-journal/journal-host-database-test-support'
import {
  createStartupRig,
  type StartupRig
} from './structured-agent-session-startup-listing-test-rig'

let rig: StartupRig

beforeEach(async () => {
  rig = await createStartupRig()
})

afterEach(async () => {
  await rig.dispose()
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
})

const tab = (sessionId: string, workspaceId = 'workspace-1') => ({
  sessionId,
  workspaceId,
  agent: 'codex'
})

describe('the tab list after a restart', () => {
  it('lists every chat it is given without opening one', async () => {
    await rig.chat('session-a', { message: 'one' })
    await rig.chat('session-b', { message: 'two' })
    await rig.crash()
    const host = await rig.boot()

    expect(host.listSessionTabs(['session-a', 'session-b'])).toEqual([
      tab('session-a'),
      tab('session-b')
    ])
    expect(rig.historyFilePath).not.toHaveBeenCalled()
  })

  it('keeps a chat with no history on disk, which then reads empty and takes a send (T3)', async () => {
    // Its first start failed before the conversation opened, so no history was ever written.
    rig.acquire.mockRejectedValueOnce(new Error('spawn failed'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(rig.chat('session-new')).rejects.toThrow(/attach refused/)
    await rig.store.setSessionTabVisibility('session-new', true)
    await rig.chat('session-old', { message: 'hello' })
    await rig.crash()
    const host = await rig.boot()
    const ids = ['session-new', 'session-old']

    await host.restoreReadableSessions(ids)

    expect(host.listSessionTabs(ids)).toEqual([tab('session-new'), tab('session-old')])
    // The restore founds no history for it; the tab stands anyway.
    expect(rig.opensOf('session-new')).toBe(0)
    const page = await host.history({ sessionId: 'session-new', direction: 'tail' })
    expect(page.ok && page.page.items).toEqual([])
    const sent = await rig.send('session-new', 'first words')
    expect(sent).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(rig.dispatch).toHaveBeenCalledOnce())
    const after = await host.history({ sessionId: 'session-new', direction: 'tail' })
    expect(JSON.stringify(after.ok && after.page)).toContain('first words')
  })

  it('keeps a chat whose history cannot be opened, and its read says why (T4)', async () => {
    await rig.chat('session-bad', { message: 'lost' })
    await rig.chat('session-good', { message: 'kept' })
    await rig.crash()
    const host = await rig.boot()
    rig.historyFilePath.mockImplementation(async (sessionId) => {
      if (sessionId === 'session-bad') {
        throw new Error('EACCES: permission denied')
      }
      return null
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ids = ['session-bad', 'session-good']

    await host.restoreReadableSessions(ids).catch(() => undefined)

    expect(host.listSessionTabs(ids)).toEqual([tab('session-bad'), tab('session-good')])
    const read = await host.history({ sessionId: 'session-bad', direction: 'tail' }).then(
      () => null,
      (error: unknown) => error
    )
    expect(isAgentSessionRefusalError(read) && read.refusal.code).toBe(
      'agent_session_journal_unreadable'
    )
  })

  it('lists in the order it is given, once each, whatever order the records are in (T7)', async () => {
    await rig.chat('session-c')
    await rig.chat('session-a')
    await rig.chat('session-b')
    await rig.crash()
    const host = await rig.boot()

    expect(host.listSessionTabs(['session-b', 'session-c', 'session-a', 'session-b'])).toEqual([
      tab('session-b'),
      tab('session-c'),
      tab('session-a')
    ])
  })

  it('lists no chat without a record, and none this host cannot serve (T10, regression guard)', async () => {
    await rig.chat('session-served', { message: 'here' })
    await rig.chat('session-gated', { workspaceId: 'workspace-gated', message: 'there' })
    await rig.crash()
    const host = await rig.boot()
    rig.unsupportedWorkspaceIds.add('workspace-gated')
    const ids = ['session-served', 'session-gated', 'session-missing']

    await host.restoreReadableSessions(ids)

    expect(host.listSessionTabs(ids)).toEqual([tab('session-served')])
  })
})
