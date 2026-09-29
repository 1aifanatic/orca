import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { createAgentCompletionCoordinator } from '../../renderer/src/components/terminal-pane/agent-completion-coordinator'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const ALPHA = { tool_name: 'Bash', tool_input: { command: 'chmod 644 alpha.txt' } }
const BETA = { tool_name: 'Bash', tool_input: { command: 'chmod 644 beta.txt' } }

// STA-3049. With the ledger deciding every hook, the row must still survive the evidence that
// names no tool call (an OSC repaint) and re-statements must not re-alert.
describe('a held Claude approval under repaint and re-statement', () => {
  let server: AgentHookServer

  beforeEach(async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
  })

  const post = (payload: Record<string, unknown>): Promise<Response> =>
    postHookEvent(server, buildBody(payload))

  function osc(state: 'working' | 'done'): void {
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: null,
      payload: { state, prompt: '', agentType: 'claude' }
    })
  }

  async function raiseAlphaBesideBeta(): Promise<void> {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'set permissions' })
    await post({ hook_event_name: 'PreToolUse', ...ALPHA, tool_use_id: 'toolu-alpha' })
    await post({ hook_event_name: 'PreToolUse', ...BETA, tool_use_id: 'toolu-beta' })
    await post({ hook_event_name: 'PermissionRequest', ...ALPHA })
  }

  const row = () => server.getStatusSnapshot()[0]

  it('keeps the main agent prompt visible when OSC repaints working, even after a re-statement', async () => {
    await raiseAlphaBesideBeta()
    osc('working')
    expect(row()).toMatchObject({ state: 'waiting', toolName: 'Bash' })

    // A child event re-states the row under its own hook name; the freeze must not depend on it.
    await post({
      hook_event_name: 'PostToolUse',
      agent_id: 'agent-child-a',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/child.txt' },
      tool_use_id: 'toolu-child'
    })
    osc('working')
    expect(row()).toMatchObject({ state: 'waiting', toolInput: 'chmod 644 alpha.txt' })

    await post({ hook_event_name: 'PostToolUse', ...ALPHA, tool_use_id: 'toolu-alpha' })
    expect(row()?.state).toBe('working')
  })

  it('still lets OSC working clear an answered question, which emits no hook of its own', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'ask me' })
    await post({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Proceed?' }] },
      tool_use_id: 'toolu-question'
    })
    expect(row()?.state).toBe('waiting')

    osc('working')

    expect(row()?.state).toBe('working')
  })

  // The hole this PR closes: a child event re-stated the row, which disarmed the freeze, so a
  // sibling of the prompt's own batch finishing then dropped the card of a still-live dialog.
  it('keeps the prompt when a sibling completes after a child event re-stated the row', async () => {
    await raiseAlphaBesideBeta()
    await post({
      hook_event_name: 'PreToolUse',
      agent_id: 'agent-child-a',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/child.txt' },
      tool_use_id: 'toolu-child'
    })
    await post({ hook_event_name: 'PostToolUse', ...BETA, tool_use_id: 'toolu-beta' })

    expect(row()).toMatchObject({ state: 'waiting', toolInput: 'chmod 644 alpha.txt' })
  })

  it('releases a re-delivered prompt with the one completion of its call', async () => {
    await raiseAlphaBesideBeta()
    await post({ hook_event_name: 'PermissionRequest', ...ALPHA })
    await post({ hook_event_name: 'PostToolUse', ...ALPHA, tool_use_id: 'toolu-alpha' })

    expect(row()?.state).toBe('working')
  })

  // Two byte-identical calls in one batch give two id-less prompts no field can tell apart from a
  // re-delivery; the first call finishing must not drop the card of the second, still-live one.
  it('keeps the second prompt of two identical calls until both complete', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'twice' })
    await post({ hook_event_name: 'PreToolUse', ...ALPHA, tool_use_id: 'toolu-first' })
    await post({ hook_event_name: 'PreToolUse', ...ALPHA, tool_use_id: 'toolu-second' })
    await post({ hook_event_name: 'PermissionRequest', ...ALPHA })
    await post({ hook_event_name: 'PermissionRequest', ...ALPHA })

    await post({ hook_event_name: 'PostToolUse', ...ALPHA, tool_use_id: 'toolu-first' })
    expect(row()?.state).toBe('waiting')

    await post({ hook_event_name: 'PostToolUse', ...ALPHA, tool_use_id: 'toolu-second' })
    expect(row()?.state).toBe('working')
  })

  it('raises exactly one needs-input alert across every re-statement of one wait', async () => {
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: PANE,
      statusLane: 'hook',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion: vi.fn(),
      dispatchAttention,
      isLive: () => true
    })
    const pushed: { state: string; stateStartedAt?: number }[] = []
    server.subscribeEnrichedStatus((enriched) => {
      const snapshot = { ...enriched.payload, stateStartedAt: enriched.stateStartedAt }
      pushed.push(snapshot)
      coordinator.observeHookStatus(snapshot)
    })
    try {
      await raiseAlphaBesideBeta()
      await post({
        hook_event_name: 'PostToolUse',
        agent_id: 'agent-child-a',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/child.txt' },
        tool_use_id: 'toolu-child'
      })
      await post({ hook_event_name: 'PostToolUse', ...BETA, tool_use_id: 'toolu-beta' })
      // A repaint that dropped the card here would make the next re-statement a fresh alert.
      osc('working')
      await post({
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'todo' },
        tool_use_id: 'toolu-grep'
      })

      const waits = pushed.filter((payload) => payload.state === 'waiting')
      expect(waits.length).toBeGreaterThan(1)
      expect(new Set(waits.map((payload) => payload.stateStartedAt)).size).toBe(1)
      expect(dispatchAttention).toHaveBeenCalledTimes(1)
    } finally {
      coordinator.dispose()
    }
  })
})
