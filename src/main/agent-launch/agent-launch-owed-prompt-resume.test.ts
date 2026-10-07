import { settleAgentSessionOperationInto } from '../runtime/agent-session-operation-admission'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionOperationKey,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import { isAgentLaunchResult, type AgentLaunchResult } from '../../shared/agent-launch-intent'
import type { AgentSessionStoreState } from '../runtime/agent-session-store-state'
import {
  resetOwedLaunchPromptResumesForTests,
  resumeOwedLaunchPrompts,
  type OwedLaunchPromptResumeDeps
} from './agent-launch-owed-prompt-resume'

const PTY = { ptyId: 'pty-7', incarnationId: 'inc-1' }

const LAUNCH: AgentLaunchResult = {
  outcome: { kind: 'terminal', handle: 'term-old', paneKey: 'tab-1:leaf-1' },
  worktreeId: 'wt-1',
  receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'Terminal.' },
  prompt: { delivery: 'submit', outcome: 'unconfirmed' }
}

function owingRow(
  promptDelivery: AgentSessionOperationRow['promptDelivery']
): AgentSessionOperationRow {
  return {
    callerKey: 'trusted-local:desktop',
    operationId: 'op-1',
    fingerprint: 'fp',
    operationTimestamp: 1,
    recordedAt: 1,
    expiresAt: 10_000,
    outcome: { status: 'succeeded', sessionId: '', launch: LAUNCH },
    promptDelivery
  }
}

function harness(
  row: AgentSessionOperationRow,
  overrides: Partial<OwedLaunchPromptResumeDeps> = {}
) {
  const key = agentSessionOperationKey(row.callerKey, row.operationId)
  const draft = { operations: new Map([[key, row]]) }
  const writes: string[] = []
  const deps: OwedLaunchPromptResumeDeps = {
    store: {
      listOperationRows: () => [...draft.operations.values()],
      transactOperations: async <T>(apply: (state: AgentSessionStoreState) => T) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these writes read and replace only `operations`.
        apply(draft as unknown as AgentSessionStoreState),
      recordOperationOutcome: async (args: Parameters<typeof settleAgentSessionOperationInto>[1]) =>
        settleAgentSessionOperationInto(draft, args)
    },
    terminalForPane: () => ({ handle: 'term-live', terminal: PTY }),
    deliver: vi.fn(async (args) => {
      if ((await args.beginPromptWrite()) === 'taken') {
        return false
      }
      writes.push(args.text)
      return true
    }),
    isLaunchRunning: () => false,
    now: () => 100,
    ...overrides
  }
  const current = () => draft.operations.get(key)
  const promptOutcome = () => {
    const outcome = current()?.outcome
    return outcome?.status === 'succeeded' && isAgentLaunchResult(outcome.launch)
      ? outcome.launch.prompt?.outcome
      : undefined
  }
  return { deps, writes, current, promptOutcome }
}

beforeEach(() => resetOwedLaunchPromptResumesForTests())

describe('a first prompt the host still owed when it stopped', () => {
  it('is pasted once into the agent that is still running, then settled', async () => {
    const h = harness(
      owingRow({
        state: 'owed',
        text: 'fix the checks',
        agent: 'claude',
        deadline: 5_000,
        terminal: PTY
      })
    )
    await resumeOwedLaunchPrompts(h.deps)
    expect(h.writes).toEqual(['fix the checks'])
    expect(h.deps.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: 'term-live',
        agent: 'claude',
        callerKey: 'trusted-local:desktop'
      })
    )
    expect(h.promptOutcome()).toBe('handed-to-terminal')
    expect(h.current()?.promptDelivery).toBeUndefined()
  })

  it('stays owed, and asks for another sweep, while its terminal is not found yet', async () => {
    // Not found is not gone: an SSH relay reports its terminals after the window's startup step.
    const h = harness(
      owingRow({
        state: 'owed',
        text: 'fix the checks',
        agent: 'claude',
        deadline: 5_000,
        terminal: PTY
      }),
      { terminalForPane: () => null }
    )
    await expect(resumeOwedLaunchPrompts(h.deps)).resolves.toBe(true)
    expect(h.deps.deliver).not.toHaveBeenCalled()
    expect(h.promptOutcome()).toBe('unconfirmed')
    expect(h.current()?.promptDelivery).toMatchObject({ state: 'owed' })
  })

  it.each([
    // The daemon lost the agent's PTY and a cold restore respawned a shell under the same id.
    ['the same id, respawned', { ptyId: 'pty-7', incarnationId: 'inc-2' }],
    ['another PTY', { ptyId: 'pty-9', incarnationId: 'inc-2' }],
    ['another PTY whose incarnation is unknown', { ptyId: 'pty-9', incarnationId: null }]
  ])(
    'is never pasted into another process the pane holds now (%s): not delivered',
    async (_, now) => {
      const h = harness(
        owingRow({
          state: 'owed',
          text: 'fix the checks',
          agent: 'claude',
          deadline: 5_000,
          terminal: PTY
        }),
        { terminalForPane: () => ({ handle: 'term-new', terminal: now }) }
      )
      await expect(resumeOwedLaunchPrompts(h.deps)).resolves.toBe(false)
      expect(h.deps.deliver).not.toHaveBeenCalled()
      expect(h.promptOutcome()).toBe('not-delivered')
    }
  )

  it('pastes into the same PTY when only one side knows its incarnation', async () => {
    const h = harness(
      owingRow({
        state: 'owed',
        text: 'fix the checks',
        agent: 'claude',
        deadline: 5_000,
        terminal: { ptyId: 'pty-7', incarnationId: null }
      })
    )
    await resumeOwedLaunchPrompts(h.deps)
    expect(h.writes).toEqual(['fix the checks'])
  })

  it('looks again after a failure only while the prompt is owed and inside its deadline', async () => {
    const failing = {
      deliver: vi.fn(async () => {
        throw new Error('boom')
      })
    }
    const owed = harness(
      owingRow({
        state: 'owed',
        text: 'fix the checks',
        agent: 'claude',
        deadline: 5_000,
        terminal: PTY
      }),
      failing
    )
    await expect(resumeOwedLaunchPrompts(owed.deps)).resolves.toBe(true)
    const writing = harness(owingRow({ state: 'writing', since: 50 }), {
      store: {
        listOperationRows: () => [owingRow({ state: 'writing', since: 50 })],
        transactOperations: async () => {
          throw new Error('SQLITE_BUSY')
        },
        recordOperationOutcome: async () => {
          throw new Error('SQLITE_BUSY')
        }
      }
    })
    await expect(resumeOwedLaunchPrompts(writing.deps)).resolves.toBe(false)
  })

  it('is not delivered, and its text is gone, once past its deadline', async () => {
    const h = harness(
      owingRow({
        state: 'owed',
        text: 'fix the checks',
        agent: 'claude',
        deadline: 50,
        terminal: PTY
      })
    )
    await expect(resumeOwedLaunchPrompts(h.deps)).resolves.toBe(false)
    expect(h.deps.deliver).not.toHaveBeenCalled()
    expect(h.promptOutcome()).toBe('not-delivered')
    expect(JSON.stringify(h.current())).not.toContain('fix the checks')
  })

  it('writes nothing when its wait for the agent runs past the deadline: not delivered', async () => {
    // Started inside the deadline; the agent became ready only after it.
    let now = 4_000
    const h = harness(
      owingRow({
        state: 'owed',
        text: 'fix the checks',
        agent: 'claude',
        deadline: 5_000,
        terminal: PTY
      }),
      {
        now: () => now,
        deliver: vi.fn(async (args) => {
          now = 6_000
          return (await args.beginPromptWrite()) === 'began'
        })
      }
    )
    await expect(resumeOwedLaunchPrompts(h.deps)).resolves.toBe(false)
    expect(h.promptOutcome()).toBe('not-delivered')
    expect(h.current()?.promptDelivery).toBeUndefined()
  })

  it('is never written again once its write may have begun: unconfirmed', async () => {
    const h = harness(owingRow({ state: 'writing', since: 50 }))
    await resumeOwedLaunchPrompts(h.deps)
    expect(h.deps.deliver).not.toHaveBeenCalled()
    expect(h.promptOutcome()).toBe('unconfirmed')
    expect(h.current()?.promptDelivery).toBeUndefined()
  })

  it('is pasted once when two resumes run at the same time', async () => {
    const h = harness(
      owingRow({
        state: 'owed',
        text: 'fix the checks',
        agent: 'claude',
        deadline: 5_000,
        terminal: PTY
      })
    )
    await Promise.all([resumeOwedLaunchPrompts(h.deps), resumeOwedLaunchPrompts(h.deps)])
    expect(h.writes).toEqual(['fix the checks'])
  })

  it('is left to the launch this process is still running', async () => {
    const h = harness(
      owingRow({
        state: 'owed',
        text: 'fix the checks',
        agent: 'claude',
        deadline: 5_000,
        terminal: PTY
      }),
      {
        isLaunchRunning: () => true
      }
    )
    await resumeOwedLaunchPrompts(h.deps)
    expect(h.deps.deliver).not.toHaveBeenCalled()
    expect(h.current()?.promptDelivery).toEqual({
      state: 'owed',
      text: 'fix the checks',
      agent: 'claude',
      deadline: 5_000,
      terminal: PTY
    })
  })
})
