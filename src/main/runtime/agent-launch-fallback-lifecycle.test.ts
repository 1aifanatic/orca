import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'
import {
  agentSessionOperationKey,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import {
  beginOwedLaunchPromptWriteInto,
  OWED_LAUNCH_PROMPT_DEADLINE_MS
} from './agent-launch-owed-prompt-record'
import { createLaunchFallbackRuntime } from './agent-launch-fallback.test-fixture'

vi.mock('../git/worktree', () => {
  const list = async () => [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/test',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return { listWorktrees: list, listWorktreesStrict: list }
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function pendingInspection() {
  const rig = await createLaunchFallbackRuntime()
  let resolve!: (process: TerminalProcessInspection) => void
  rig.inspectProcess.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  return {
    ...rig,
    resolve: () => resolve({ foregroundProcess: 'opencode', hasChildProcesses: false })
  }
}

function owedRow() {
  const ref = { callerKey: 'trusted-local:desktop', operationId: 'late-launch' }
  const row: AgentSessionOperationRow = {
    ...ref,
    fingerprint: 'test',
    operationTimestamp: 0,
    recordedAt: 0,
    expiresAt: 600_000,
    outcome: { status: 'pending' },
    promptDelivery: {
      state: 'owed',
      text: 'fix the conflict\nthen test',
      agent: 'opencode',
      deadline: OWED_LAUNCH_PROMPT_DEADLINE_MS,
      terminal: { ptyId: 'pty-prompt', incarnationId: null }
    }
  }
  const state = {
    operations: new Map([[agentSessionOperationKey(ref.callerKey, ref.operationId), row]])
  }
  return { state, ref, begin: async () => beginOwedLaunchPromptWriteInto(state, ref, Date.now()) }
}

describe('a fallback inspection that settles after the nominal one-second budget', () => {
  it('still delivers on the original live terminal when its owed deadline has not passed', async () => {
    const rig = await pendingInspection()
    const record = owedRow()
    const result = rig.deliver({ beginPromptWrite: record.begin })
    await vi.advanceTimersByTimeAsync(22_000)
    expect(rig.inspectProcess).toHaveBeenCalledOnce()
    expect(rig.writes).toEqual([])
    rig.resolve()
    await vi.runAllTimersAsync()
    expect(await result).toBe(true)
    expect(rig.writes).toHaveLength(2)
    expect(rig.writeTimes[0]).toBe(22_000)
    expect(
      record.state.operations.get(
        agentSessionOperationKey(record.ref.callerKey, record.ref.operationId)
      )?.promptDelivery
    ).toEqual({ state: 'writing', since: 22_000 })
  })

  it('writes zero bytes after the real five-minute owed deadline, even on a live agent', async () => {
    const rig = await pendingInspection()
    const record = owedRow()
    const result = rig.deliver({ beginPromptWrite: record.begin })
    await vi.advanceTimersByTimeAsync(OWED_LAUNCH_PROMPT_DEADLINE_MS + 1)
    rig.resolve()
    await vi.runAllTimersAsync()
    expect(await result).toBe(false)
    expect(rig.writes).toEqual([])
  })

  it('rejects a changed lifecycle generation while the positive inspection is pending', async () => {
    const rig = await pendingInspection()
    const result = rig.deliver()
    await vi.advanceTimersByTimeAsync(20_000)
    rig.runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      0
    )
    rig.resolve()
    await vi.runAllTimersAsync()
    expect(await result).toBe(false)
    expect(rig.writes).toEqual([])
  })

  it('rejects an exited terminal while the positive inspection is pending', async () => {
    const rig = await pendingInspection()
    const result = rig.deliver()
    await vi.advanceTimersByTimeAsync(20_000)
    await rig.runtime.onPtyExit('pty-prompt', 0)
    rig.resolve()
    await vi.runAllTimersAsync()
    expect(await result).toBe(false)
    expect(rig.writes).toEqual([])
  })

  it('does not reuse a replacement that appeared during the preceding composer wait', async () => {
    const rig = await createLaunchFallbackRuntime({
      process: { foregroundProcess: 'opencode', hasChildProcesses: false }
    })
    const result = rig.deliver()
    await vi.advanceTimersByTimeAsync(1_000)
    rig.runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      0
    )
    await vi.runAllTimersAsync()
    expect(await result).toBe(false)
    expect(rig.writes).toEqual([])
  })
})
