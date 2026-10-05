// A paired desktop that (re)connects while a headless host's Codex pane sits idle under a neutral
// title must open that pane's conversation from the host's published identity, with no status row.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'

vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

import { useAppStore } from '@/store'
import { resolveNativeChatSession } from '@/components/native-chat/native-chat-pane-resolution'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch,
  decideWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests
} from './web-session-tabs-sync'

const ENVIRONMENT_ID = 'cold-desktop-env'
const FIXTURE_PATH = join(
  __dirname,
  '../../../shared/__fixtures__/terminal-conversation-identity-idle-frame.json'
)

type FixtureTab = Record<string, unknown> & { parentTabId: string; leafId: string }

function readFixtureFrame(): RuntimeMobileSessionTabsResult {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
}

function applyFrame(frame: RuntimeMobileSessionTabsResult): void {
  // Why a JSON round trip: the desktop only ever sees what survived the wire.
  const received: RuntimeMobileSessionTabsResult = JSON.parse(JSON.stringify(frame))
  applyWebSessionTabsStorePatch(
    (state) => applyWebSessionTabsSnapshot(state, received, ENVIRONMENT_ID, Date.now()),
    {
      frames: [
        {
          environmentId: ENVIRONMENT_ID,
          worktreeId: received.worktree,
          decision: decideWebSessionTabsSnapshot(received, ENVIRONMENT_ID)
        }
      ]
    },
    received,
    false
  )
}

function fixtureTab(frame: RuntimeMobileSessionTabsResult): FixtureTab {
  const tab = frame.tabs[0]
  if (!tab || tab.type !== 'terminal') {
    throw new Error('fixture must hold one terminal tab')
  }
  return tab
}

function resolveLeaf(frame: RuntimeMobileSessionTabsResult, leafId: string) {
  const state = useAppStore.getState()
  const hostTab = fixtureTab(frame)
  const localTabId = toWebTerminalSurfaceTabId(hostTab.parentTabId)
  const paneKey = makePaneKey(localTabId, leafId)
  const mirrored = state.tabsByWorktree[frame.worktree]?.find((tab) => tab.id === localTabId)
  expect(mirrored).toBeDefined()
  return resolveNativeChatSession({
    paneKey,
    launchAgent: mirrored?.launchAgent,
    agentStatusEntry: state.agentStatusByPaneKey[paneKey],
    conversation: mirrored?.hostConversationByLeafId?.[leafId],
    ptyId: mirrored?.ptyId ?? null
  })
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  resetWebSessionTabsSnapshotFreshnessForTests()
})

describe('cold paired desktop, idle headless Codex pane', () => {
  it('resolves the pane conversation from the published identity while no status exists', () => {
    const frame = readFixtureFrame()
    const tab = fixtureTab(frame)
    expect(tab).not.toHaveProperty('agentStatus')
    expect(tab).not.toHaveProperty('launchAgent')

    applyFrame(frame)

    expect(useAppStore.getState().agentStatusByPaneKey).toEqual({})
    const resolution = resolveLeaf(frame, tab.leafId)
    expect(resolution?.sessionId ?? null).toBe('ac1f6b90-2f77-4f0e-9c5e-1d2f6a4b8c31')
    expect(resolution?.transcriptPath).toBe('/fixture/rollout.jsonl')
    expect(resolution?.agent).toBe('codex')
  })

  it('gives no address when the host does not offer the identity on a statusless tab', () => {
    const frame = readFixtureFrame()
    const tab = fixtureTab(frame)
    delete tab.conversationOfferedWithoutStatus

    applyFrame(frame)

    expect(resolveLeaf(frame, tab.leafId)).toBeNull()
  })
})
