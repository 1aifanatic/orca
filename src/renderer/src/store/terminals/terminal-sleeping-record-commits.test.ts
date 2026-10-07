import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, makeTab } from '../slices/store-test-helpers'
import { takeSleepingRecordChanges } from './terminal-sleeping-record-commits'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`
const MOVED = `tab-2:${LEAF}`
const session = { key: 'session_id' as const, id: 'codex-session-1' }

let api: {
  sleepTerminalLeaves: ReturnType<typeof vi.fn>
  wakeTerminalLeaves: ReturnType<typeof vi.fn>
  closeTerminalSurface: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  api = {
    sleepTerminalLeaves: vi.fn(async () => {}),
    wakeTerminalLeaves: vi.fn(async () => {}),
    closeTerminalSurface: vi.fn(async () => ({}))
  }
  vi.stubGlobal('window', { api: { session: api } })
})

afterEach(() => {
  takeSleepingRecordChanges()
  vi.unstubAllGlobals()
})

/** A store whose agent pane already has a committed sleeping record. */
async function storeWithSleepingAgent() {
  const store = createTestStore()
  store.setState({
    tabsByWorktree: {
      'wt-1': [
        makeTab({ id: 'tab-1', worktreeId: 'wt-1' }),
        makeTab({ id: 'tab-2', worktreeId: 'wt-1' })
      ]
    }
  })
  store
    .getState()
    .setAgentStatus(
      PANE,
      { state: 'working', prompt: 'finish the task', agentType: 'codex' },
      'Codex',
      { updatedAt: 10, stateStartedAt: 10 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession: session }
    )
  await Promise.resolve()
  api.sleepTerminalLeaves.mockClear()
  return store
}

describe("this window's sleeping-record commits", () => {
  it('a new record sleeps its leaf, in one batch', async () => {
    const store = await storeWithSleepingAgent()
    const committed = store.getState().sleepingAgentSessionsByPaneKey[PANE]
    expect(committed?.providerSession).toEqual(session)

    store
      .getState()
      .recordAgentProviderSession(
        PANE,
        'codex',
        { ...session, id: 'codex-session-2' },
        { updatedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1' }
      )
    store.getState().captureAllSleepingAgentSessions('periodic')
    await Promise.resolve()

    expect(api.sleepTerminalLeaves).toHaveBeenCalledTimes(1)
    expect(api.sleepTerminalLeaves).toHaveBeenCalledWith({
      [PANE]: store.getState().sleepingAgentSessionsByPaneKey[PANE]
    })
    expect(api.wakeTerminalLeaves).not.toHaveBeenCalled()
  })

  it('the periodic capture commits what it captured', async () => {
    const store = await storeWithSleepingAgent()
    // A live agent whose record main's last push dropped.
    store.setState({ sleepingAgentSessionsByPaneKey: {} })

    store.getState().captureAllSleepingAgentSessions('periodic')
    const captured = store.getState().sleepingAgentSessionsByPaneKey[PANE]
    await Promise.resolve()

    expect(captured?.providerSession).toEqual(session)
    expect(api.sleepTerminalLeaves).toHaveBeenCalledWith({ [PANE]: captured })
  })

  it('a removal wakes its leaf', async () => {
    const store = await storeWithSleepingAgent()

    store.getState().clearSleepingAgentSession(PANE)
    await Promise.resolve()

    expect(api.wakeTerminalLeaves).toHaveBeenCalledWith([PANE])
    expect(api.sleepTerminalLeaves).not.toHaveBeenCalled()
  })

  it('a pane move and a tab close commit nothing: main moves and closes them itself', async () => {
    const store = await storeWithSleepingAgent()

    store.getState().transferAgentPaneAuthority({ fromPaneKey: PANE, toPaneKey: MOVED })
    expect(Object.keys(store.getState().sleepingAgentSessionsByPaneKey)).toEqual([MOVED])
    store.getState().closeTab('tab-2')
    expect(store.getState().sleepingAgentSessionsByPaneKey).toEqual({})
    await Promise.resolve()

    expect(api.sleepTerminalLeaves).not.toHaveBeenCalled()
    expect(api.wakeTerminalLeaves).not.toHaveBeenCalled()
  })

  it('the quit stage takes the quit capture synchronously, and nothing is sent after', async () => {
    const store = await storeWithSleepingAgent()

    store.getState().captureAllSleepingAgentSessions('quit')
    const changes = takeSleepingRecordChanges()
    await Promise.resolve()

    expect(changes).toEqual({
      sleep: { [PANE]: store.getState().sleepingAgentSessionsByPaneKey[PANE] },
      wake: []
    })
    expect(changes.sleep[PANE]?.origin).toBe('quit')
    expect(api.sleepTerminalLeaves).not.toHaveBeenCalled()
  })
})
