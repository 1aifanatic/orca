import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, makeTab } from '../slices/store-test-helpers'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`
const MOVED = `tab-2:${LEAF}`
const session = { key: 'session_id' as const, id: 'codex-session-1' }

let api: {
  commitTerminalSleepingRecords: ReturnType<typeof vi.fn>
  closeTerminalSurface: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  api = {
    commitTerminalSleepingRecords: vi.fn(async () => {}),
    closeTerminalSurface: vi.fn(async () => ({}))
  }
  vi.stubGlobal('window', { api: { session: api } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A store whose agent pane already has a committed sleeping record. */
function storeWithSleepingAgent() {
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
  api.commitTerminalSleepingRecords.mockClear()
  return store
}

describe("this window's sleeping-record commits", () => {
  it('a changed record sleeps its leaf, sent with the write', () => {
    const store = storeWithSleepingAgent()
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE]?.providerSession).toEqual(session)

    store
      .getState()
      .recordAgentProviderSession(
        PANE,
        'codex',
        { ...session, id: 'codex-session-2' },
        { updatedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1' }
      )

    expect(api.commitTerminalSleepingRecords).toHaveBeenCalledTimes(1)
    expect(api.commitTerminalSleepingRecords).toHaveBeenCalledWith({
      sleep: { [PANE]: store.getState().sleepingAgentSessionsByPaneKey[PANE] },
      wake: []
    })
  })

  it('the periodic capture commits what it captured', () => {
    const store = storeWithSleepingAgent()
    // A live agent whose record main's last push dropped.
    store.setState({ sleepingAgentSessionsByPaneKey: {} })

    store.getState().captureAllSleepingAgentSessions('periodic')
    const captured = store.getState().sleepingAgentSessionsByPaneKey[PANE]

    expect(captured?.providerSession).toEqual(session)
    expect(api.commitTerminalSleepingRecords).toHaveBeenCalledWith({
      sleep: { [PANE]: captured },
      wake: []
    })
  })

  it('the quit capture is sent before the capture returns, so it precedes the quit stage', () => {
    const store = storeWithSleepingAgent()

    store.getState().captureAllSleepingAgentSessions('quit')

    const sent = api.commitTerminalSleepingRecords.mock.calls.at(-1)?.[0]
    expect(sent?.sleep[PANE]).toBe(store.getState().sleepingAgentSessionsByPaneKey[PANE])
    expect(sent?.sleep[PANE]?.origin).toBe('quit')
  })

  it('a removal wakes its leaf', () => {
    const store = storeWithSleepingAgent()

    store.getState().clearSleepingAgentSession(PANE)

    expect(api.commitTerminalSleepingRecords).toHaveBeenCalledWith({ sleep: {}, wake: [PANE] })
  })

  it('a pane move and a tab close commit nothing: main moves and closes them itself', () => {
    const store = storeWithSleepingAgent()

    store.getState().transferAgentPaneAuthority({ fromPaneKey: PANE, toPaneKey: MOVED })
    expect(Object.keys(store.getState().sleepingAgentSessionsByPaneKey)).toEqual([MOVED])
    store.getState().closeTab('tab-2')
    expect(store.getState().sleepingAgentSessionsByPaneKey).toEqual({})

    expect(api.commitTerminalSleepingRecords).not.toHaveBeenCalled()
  })
})
