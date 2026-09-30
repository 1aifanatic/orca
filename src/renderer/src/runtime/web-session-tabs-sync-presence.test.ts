import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'
vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))
const presence = {
  agent: 'claude',
  process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
} as const
function snapshot(ended: boolean) {
  return makeSnapshot([
    {
      type: 'terminal',
      id: HOST_SURFACE_ID,
      parentTabId: 'host-tab-1',
      leafId: LEAF_ID,
      title: 'zsh',
      launchAgent: 'claude',
      isActive: true,
      status: 'ready',
      terminal: 'terminal-1',
      agentStatus: {
        state: 'done',
        prompt: '',
        updatedAt: 10,
        stateStartedAt: 10,
        paneKey: makePaneKey('host-tab-1', LEAF_ID),
        agentType: 'claude',
        stateHistory: [],
        agentPresence: { ...presence, ...(ended ? { ended: true } : {}) }
      }
    }
  ])
}
describe('paired host presence', () => {
  beforeEach(resetWebSessionTabsSyncTestState)
  it('keeps host evidence clocks and applies an exit independently of client turn clocks', () => {
    const state = makeState()
    const first = applyWebSessionTabsSnapshot(state, snapshot(false), ENV, NOW)
    expect(first?.agentPresenceByPaneKey).toBeDefined()
    const paneKey = Object.keys(first?.agentPresenceByPaneKey ?? {})[0]
    expect(first?.agentPresenceByPaneKey?.[paneKey]).toMatchObject({
      presence,
      receivedAt: 10,
      connectionId: ENV
    })
    const mirrored = { ...state, ...first }
    const turn = mirrored.agentStatusByPaneKey[paneKey]
    mirrored.agentStatusByPaneKey = {
      ...mirrored.agentStatusByPaneKey,
      [paneKey]: { ...turn, state: 'working', updatedAt: NOW + 99999 }
    }
    const next = applyWebSessionTabsSnapshot(mirrored, snapshot(true), ENV, NOW + 1)
    expect(next?.agentPresenceByPaneKey?.[paneKey]?.presence.ended).toBe(true)
    expect(next?.agentStatusByPaneKey?.[paneKey]).toBeUndefined()
    expect(next?.tabsByWorktree?.[WT] ?? mirrored.tabsByWorktree[WT]).toHaveLength(1)
  })
})
