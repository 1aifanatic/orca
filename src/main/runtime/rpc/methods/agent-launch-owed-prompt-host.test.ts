import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOperationRow } from '../../../../shared/agent-session-operation-ledger'
import type { OrcaRuntimeService } from '../../orca-runtime'

vi.mock('../../structured-agent-session-runtime', () => ({
  hasPersistedStructuredAgentSessionStore: () => true
}))
vi.mock('../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/x'
}))

const { resumeOwedAgentLaunchPrompts } = await import('./agent-launch-owed-prompt-host')
const { resetOwedLaunchPromptResumesForTests } =
  await import('../../../agent-launch/agent-launch-owed-prompt-resume')

function owedRow(deadline: number): AgentSessionOperationRow {
  return {
    callerKey: 'trusted-local:desktop',
    operationId: 'op-1',
    fingerprint: 'fp',
    operationTimestamp: 1,
    recordedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    outcome: {
      status: 'succeeded',
      sessionId: '',
      launch: {
        outcome: { kind: 'terminal', handle: 'term_1', paneKey: 'tab:leaf' },
        worktreeId: 'wt-1',
        receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'x' },
        prompt: { delivery: 'submit', outcome: 'unconfirmed' }
      }
    },
    promptDelivery: {
      state: 'owed',
      text: 'fix it',
      agent: 'claude',
      deadline,
      terminal: { ptyId: 'pty-1', incarnationId: null }
    }
  }
}

/** A host whose agent's terminal is not found yet, as before an SSH relay reconnects. */
function host(row: AgentSessionOperationRow) {
  // One look for the agent's terminal per sweep.
  const lookups = vi.fn((_paneKey: string): string | null => null)
  const store = {
    listOperationRows: () => [row],
    transactOperations: vi.fn(),
    recordOperationOutcome: vi.fn(async () => {})
  }
  const runtime = {
    openedAgentSessionRecordStore: () => store,
    openAgentSessionRecordStore: async () => store,
    getTerminalHandleForPaneKey: lookups,
    getTerminalPtyIdentity: () => null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep reaches only these runtime and store members.
  return { runtime: runtime as unknown as OrcaRuntimeService, lookups, store }
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 })
  resetOwedLaunchPromptResumesForTests()
})
afterEach(() => vi.useRealTimers())

describe('looking again for an owed prompt’s terminal', () => {
  it('sweeps again 10 s later while the terminal is not found and the deadline holds', async () => {
    const h = host(owedRow(60_000))
    await resumeOwedAgentLaunchPrompts(h.runtime)
    expect(h.lookups).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(h.lookups).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.lookups).toHaveBeenCalledTimes(2)
  })

  it('stops once the deadline has passed: the prompt is settled, not looked for', async () => {
    const h = host(owedRow(5_000))
    await resumeOwedAgentLaunchPrompts(h.runtime)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.store.recordOperationOutcome).toHaveBeenCalledOnce()
    // Past its deadline the row is settled without a look, and nothing sweeps again.
    expect(h.lookups).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.lookups).toHaveBeenCalledTimes(1)
    expect(h.store.recordOperationOutcome).toHaveBeenCalledOnce()
  })
})
