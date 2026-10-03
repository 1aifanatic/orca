import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { flushAsyncTicks, writeHeadlessTerminal } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
  createManager
} from './pty-connection-test-pane-fixtures'
import type { ConnectCallbacks, MockTransport } from './pty-connection-test-pane-fixtures'
import type { PtyReplayDataMeta } from './pty-transport-types'
import { RELEASE_SYNCHRONIZED_OUTPUT } from '../../../../shared/terminal-mode-reset-profiles'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const { scheduleRuntimeGraphSync, shouldSeedCacheTimerOnInitialTitle, toastInfo } = vi.hoisted(
  () => ({
    scheduleRuntimeGraphSync: vi.fn(),
    shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
    toastInfo: vi.fn()
  })
)

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

const COLS = 40
const ROWS = 6
// A setup script's history, then an agent TUI that entered the alt screen.
const SETUP_HISTORY = Array.from({ length: 10 }, (_, i) => `SETUP-OUTPUT-${i}`).join('\r\n')
const STALE_TUI_FRAME = '\x1b[?1049h\x1b[2J\x1b[HOLD-AGENT-FRAME'
// Host image shape: normal-buffer history first, then the image enters alt itself and
// paints with cursor jumps over cells it expects blank, as agent TUIs do.
const HOST_IMAGE = `${SETUP_HISTORY}\r\n\x1b[?1049h\x1b[H\x1b[2;1HNo\x1b[1Cnotice\x1b[1Ctoday`

function viewportLines(term: Terminal): string[] {
  const buffer = term.buffer.active
  return Array.from(
    { length: term.rows },
    (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
  )
}

describe('connectPanePty replay onto a live alt screen', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  async function replayOntoLiveAltScreen(meta: PtyReplayDataMeta): Promise<string[]> {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('agent-pty')
    const replay: { current: ConnectCallbacks['onReplayData'] | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      replay.current = callbacks.onReplayData ?? null
      return 'agent-pty'
    })
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const deps = buildPaneConnectionDeps(() => mockStoreState)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures implement the pane, manager and deps members connectPanePty reads.
    const binding = connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(8)
    pane.terminal.buffer.active.type = 'alternate'
    replay.current?.(HOST_IMAGE, meta)
    for (let index = 0; index < 12; index += 1) {
      await flushAsyncTicks(4)
      parseCallbacks.shift()?.()
    }
    await flushAsyncTicks(8)
    binding.dispose()
    expect(writes).toContain(HOST_IMAGE)
    return writes
  }

  async function renderOverDirtyAltScreen(writes: string[]): Promise<Terminal> {
    const client = new Terminal({ cols: COLS, rows: ROWS, scrollback: 100, allowProposedApi: true })
    await writeHeadlessTerminal(client, `${SETUP_HISTORY}\r\n${STALE_TUI_FRAME}`)
    for (const write of writes) {
      await writeHeadlessTerminal(client, write)
    }
    return client
  }

  // Why: a revisited remote tab running an agent TUI gets a host recovery snapshot while
  // xterm is still on the agent's alt screen. Clearing without leaving alt painted the
  // image's history (old setup output) into the agent's screen, under its next paints.
  it('repaints the alt screen exactly as a fresh terminal would', async () => {
    const client = await renderOverDirtyAltScreen(
      await replayOntoLiveAltScreen({ serializedImage: true })
    )
    const fresh = new Terminal({ cols: COLS, rows: ROWS, scrollback: 100, allowProposedApi: true })
    try {
      await writeHeadlessTerminal(fresh, HOST_IMAGE)
      expect(client.buffer.active.type).toBe('alternate')
      expect(viewportLines(client)).toEqual(viewportLines(fresh))
      expect(viewportLines(client).join('\n')).not.toMatch(/SETUP-OUTPUT|OLD-AGENT-FRAME/)
    } finally {
      client.dispose()
      fresh.dispose()
    }
  })

  // Why: an SSH relay replays a raw byte window, not an image; leaving alt first would
  // strand a running TUI's bytes on the normal buffer.
  it('clears a raw byte replay in place on the alt screen', async () => {
    const writes = await replayOntoLiveAltScreen({})
    expect(writes[0]).toBe(`${RELEASE_SYNCHRONIZED_OUTPUT}\x1b[2J\x1b[3J\x1b[H`)
  })
})
