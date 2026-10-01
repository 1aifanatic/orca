import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { TuiAgent } from '../../shared/tui-agent'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import type { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// The harness pane's identity (agent-transcript-pane-test-harness.ts).
const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const OTHER_PANE_KEY = makePaneKey('tab-9', '99999999-9999-4999-8999-999999999999')
// A Codex turn in progress: no ready sign the other lanes could settle on.
const BUSY_SCREEN = '• Working (4s • esc to interrupt)\r\n'
// OpenCode 1.18's permission dialog, as the line tail keeps it after the prompt is answered.
const OPENCODE_PERMISSION_DIALOG = [
  '△ Permission required',
  '# Shell command',
  '$ echo hi',
  ' Allow once   Allow always   Reject     ctrl+f fullscreen  ⇆ select  enter confirm',
  ''
].join('\r\n')
// Shorter than the 2 s poll, so only the synchronous verdict can settle a wait.
const WAIT_MS = 150

function row(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  const now = Date.now()
  return {
    paneKey: PANE_KEY,
    connectionId: null,
    state: 'done',
    prompt: '',
    agentType: 'codex',
    receivedAt: now,
    stateStartedAt: now,
    ...overrides
  }
}

async function waitOutcome(options: {
  rows: (handle: string) => AgentStatusIpcPayload[]
  launchAgent?: TuiAgent
  paneTitle?: string
  data?: string
  afterCreate?: (runtime: OrcaRuntimeService) => void
}): Promise<string> {
  let handle = ''
  const pane = await createTranscriptPane(
    {
      paneTitle: options.paneTitle ?? 'Terminal',
      foregroundProcess: 'codex',
      data: options.data ?? BUSY_SCREEN,
      launchAgent: options.launchAgent ?? 'codex'
    },
    { getAgentStatusSnapshot: () => options.rows(handle) }
  )
  handle = pane.handle
  options.afterCreate?.(pane.runtime)
  try {
    const result = await pane.runtime.waitForTerminal(pane.handle, {
      condition: 'tui-idle',
      timeoutMs: WAIT_MS
    })
    return result.blockedReason ? `blocked:${result.blockedReason}` : 'ready'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tui-idle hook lane through the runtime', () => {
  it('settles a mid-turn screen on the hook row alone, with no ready title (headless serve)', async () => {
    expect(await waitOutcome({ rows: () => [row()] })).toBe('ready')
  })

  it('without a row, the same pane does not settle', async () => {
    expect(await waitOutcome({ rows: () => [] })).toBe('timeout')
  })

  it('holds a working turn over an explicit ready title', async () => {
    expect(await waitOutcome({ rows: () => [], paneTitle: 'Codex ready' })).toBe('ready')
    expect(
      await waitOutcome({ rows: () => [row({ state: 'working' })], paneTitle: 'Codex ready' })
    ).toBe('timeout')
  })

  it('joins a row on the terminal handle when its pane key is not the pane', async () => {
    expect(
      await waitOutcome({
        rows: (handle) => [row({ paneKey: OTHER_PANE_KEY, terminalHandle: handle })]
      })
    ).toBe('ready')
  })

  it('falls back to the other lanes for a row no pane key or handle joins', async () => {
    expect(await waitOutcome({ rows: () => [row({ paneKey: OTHER_PANE_KEY })] })).toBe('timeout')
  })

  it('ignores the row the PTY id held before a respawn', async () => {
    const before = Date.now() - 1000
    const rows = (): AgentStatusIpcPayload[] => [
      row({ receivedAt: before, stateStartedAt: before })
    ]
    expect(await waitOutcome({ rows })).toBe('ready')
    expect(
      await waitOutcome({
        rows,
        afterCreate: (runtime) =>
          runtime.synchronizePtyOutputSequenceFromProvider(TRANSCRIPT_PANE_PTY_ID, {
            value: 0,
            generation: 'reset'
          })
      })
    ).toBe('timeout')
  })

  // Pi brackets each message in OSC 133 zones itself, so a command marker is no process boundary.
  it('keeps the row while the agent paints its own shell-integration markers', async () => {
    expect(
      await waitOutcome({
        rows: () => [row({ receivedAt: Date.now() - 1000 })],
        data: `\x1b]133;A\x07OK\x1b]133;C\x07${BUSY_SCREEN}`
      })
    ).toBe('ready')
  })

  it('never settles a permission wait as ready', async () => {
    expect(await waitOutcome({ rows: () => [row({ state: 'waiting' })] })).toBe('timeout')
  })

  it("settles past a denied prompt's dialog text once the hook says the turn ended", async () => {
    const options = { launchAgent: 'opencode' as const, data: OPENCODE_PERMISSION_DIALOG }
    expect(await waitOutcome({ ...options, rows: () => [] })).toBe(
      'blocked:agent-interactive-prompt'
    )
    expect(
      await waitOutcome({
        ...options,
        rows: () => [row({ agentType: 'opencode', state: 'waiting', receivedAt: Date.now() + 1 })]
      })
    ).toBe('blocked:agent-interactive-prompt')
    expect(
      await waitOutcome({
        ...options,
        rows: () => [row({ agentType: 'opencode', receivedAt: Date.now() + 1 })]
      })
    ).toBe('ready')
  })

  it('reads no hooks for an identity-only agent', async () => {
    expect(
      await waitOutcome({ rows: () => [row({ agentType: 'claude' })], launchAgent: 'claude' })
    ).toBe('timeout')
  })
})
