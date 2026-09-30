import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
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
function snapshot(
  ended: boolean,
  row: Partial<AgentStatusEntry> = {},
  version?: number,
  surfaces = true
) {
  return makeSnapshot(
    surfaces
      ? [
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
              agentPresence: { ...presence, ...(ended ? { ended: true } : {}) },
              ...row
            }
          }
        ]
      : [],
    version === undefined
      ? {}
      : { snapshotVersion: version, ...(surfaces ? {} : { activeTabId: null }) }
  )
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

  it('drops an ended owner when a newer host row no longer carries a process', () => {
    const state = makeState()
    const ended = { ...state, ...applyWebSessionTabsSnapshot(state, snapshot(true), ENV, NOW) }
    const paneKey = Object.keys(ended.agentPresenceByPaneKey ?? {})[0]
    expect(ended.agentPresenceByPaneKey?.[paneKey]?.presence.ended).toBe(true)
    // A later agent the host cannot identify (for example Codex) publishes only a legacy row.
    const successor: Partial<AgentStatusEntry> = {
      state: 'working',
      prompt: 'refactor',
      updatedAt: 20,
      stateStartedAt: 20,
      agentType: 'codex',
      agentPresence: undefined
    }
    const next = {
      ...ended,
      ...applyWebSessionTabsSnapshot(ended, snapshot(false, successor, 2), ENV, NOW + 1)
    }
    expect(next.agentPresenceByPaneKey?.[paneKey]).toBeUndefined()
    expect(next.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'working',
      agentType: 'codex'
    })
  })

  it('does not resurrect an ended owner from an older live snapshot', () => {
    const state = makeState()
    const endedRow = { updatedAt: 20, stateStartedAt: 20 }
    const ended = {
      ...state,
      ...applyWebSessionTabsSnapshot(state, snapshot(true, endedRow), ENV, NOW)
    }
    const paneKey = Object.keys(ended.agentPresenceByPaneKey ?? {})[0]
    const stale = applyWebSessionTabsSnapshot(ended, snapshot(false, {}, 2), ENV, NOW + 1)
    const next = { ...ended, ...stale }
    expect(next.agentPresenceByPaneKey?.[paneKey]?.presence.ended).toBe(true)
  })

  it('releases mirrored presence when the host retracts the terminal', () => {
    const state = makeState()
    const live = { ...state, ...applyWebSessionTabsSnapshot(state, snapshot(false), ENV, NOW) }
    const paneKey = Object.keys(live.agentPresenceByPaneKey ?? {})[0]
    expect(live.agentPresenceByPaneKey?.[paneKey]?.presence.process).toBeDefined()
    const retracted = applyWebSessionTabsSnapshot(live, snapshot(false, {}, 2, false), ENV, NOW + 1)
    const next = { ...live, ...retracted }
    expect(Object.values(next.tabsByWorktree).flat()).toHaveLength(0)
    expect(next.agentPresenceByPaneKey?.[paneKey]).toBeUndefined()
  })
})
