// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { WebSessionTabsSyncState } from './state'

const store = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return { state }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ ...store.state, scheduleAgentStatusFreshness: () => undefined }),
    setState: (update: (state: Record<string, unknown>) => Record<string, unknown>) => {
      store.state = { ...store.state, ...update(store.state) }
    }
  }
}))

vi.mock('@/lib/launch-structured-agent-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredAgentSessionLaunchIntent: (worktreeId: string) => ({
      worktreeId,
      sessionId: 'launch-1',
      executionHostId: 'local',
      target: { kind: 'local' },
      agent: 'codex',
      params: {
        envelope: {
          sessionId: 'launch-1',
          clientOperationId: 'operation-launch-1',
          expectedRuntimeFence: null,
          payloadFingerprint: 'fingerprint-launch-1'
        },
        worktree: `id:${worktreeId}`,
        agent: 'codex'
      }
    }),
    retryStructuredAgentSessionLaunchIntent: (intent: unknown) => intent,
    restoreStructuredAgentSessionLaunchIntent: vi.fn(),
    abandonStructuredAgentSessionLaunchIntent: vi.fn(),
    launchStructuredAgentSession: () =>
      Promise.reject(new StructuredAgentSessionCreateRefusalError('unsupported')),
    StructuredAgentSessionCreateRefusalError
  }
})

import { applyWebSessionTabsSnapshot } from '../web-session-tabs-sync'
import { applyWebSessionTabsStorePatch } from './store-patch'
import {
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState,
  ENV,
  NOW,
  WT
} from '../web-session-tabs-sync-test-harness'
import {
  appendStructuredAgentSessionOutboxMessage,
  readOutbox
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import { resetStructuredAgentSessionCarriedNotesForTests } from '@/components/native-chat/structured-agent-session-outbox-carried-notes'
import { isNoteInFlight } from '@/lib/notes-send-in-flight'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from '@/lib/structured-agent-session-launch-persistence'
import { startStructuredAgentLaunch } from '@/lib/structured-agent-session-launch'
import { takeHostRemovedStructuredChats } from './host-removed-structured-chats'

const NOTE_KEY = 'note-a'

function chatTab(sessionId: string, id = `tab-${sessionId}`): Tab {
  return {
    id,
    entityId: sessionId,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    worktreeId: WT,
    groupId: 'group-1',
    label: 'Codex',
    customLabel: null,
    color: null,
    createdAt: 1,
    sortOrder: 0
  }
}

function windowWith(tabs: Tab[]): WebSessionTabsSyncState {
  return makeState({
    unifiedTabsByWorktree: { [WT]: tabs },
    groupsByWorktree: {
      [WT]: [
        {
          id: 'group-1',
          worktreeId: WT,
          tabOrder: tabs.map((tab) => tab.id),
          activeTabId: tabs[0]?.id ?? null
        }
      ]
    },
    activeGroupIdByWorktree: { [WT]: 'group-1' }
  })
}

/** A chat whose notes message the host refused: it waits on its Retry, carrying the notes. */
function refusedNotesMessage(sessionId: string): void {
  appendStructuredAgentSessionOutboxMessage(sessionId, 'review notes', [], 'launch', [NOTE_KEY])
}

/** The host's next list of chats, as this window's sync commits it. */
function hostLists(sessions: string[]): void {
  applyWebSessionTabsStorePatch(
    (state) =>
      applyWebSessionTabsSnapshot(
        state,
        makeSnapshot(
          sessions.map((sessionId) => ({
            type: 'agent-session' as const,
            id: `agent-session:${sessionId}`,
            sessionId,
            agent: 'codex' as const,
            title: 'Codex',
            isActive: false
          })),
          { snapshotVersion: 2 }
        ),
        ENV,
        NOW,
        { contentScope: 'agent-session', preserveLocalLayout: true, terminalPtyMode: 'local' }
      ),
    { frames: [] }
  )
}

describe('a chat the host stops listing', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    localStorage.clear()
    resetStructuredAgentSessionCarriedNotesForTests()
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    takeHostRemovedStructuredChats()
  })

  it('takes its queued messages with it, so the notes they carried come back', () => {
    store.state = { ...windowWith([chatTab('chat-1')]) }
    refusedNotesMessage('chat-1')
    expect(isNoteInFlight(NOTE_KEY)).toBe(true)

    hostLists([])

    expect(readOutbox('chat-1')).toEqual([])
    expect(isNoteInFlight(NOTE_KEY)).toBe(false)
  })

  it('keeps a chat the host still lists, under another local tab id', () => {
    store.state = { ...windowWith([chatTab('chat-1', 'chat-1:history-1')]) }
    refusedNotesMessage('chat-1')

    hostLists(['chat-1'])

    expect(readOutbox('chat-1')).toHaveLength(1)
    expect(isNoteInFlight(NOTE_KEY)).toBe(true)
  })

  it("keeps a failed launch's messages for its Retry: the host never listed it", async () => {
    const failed = startFailedLaunch()
    await settle()
    store.state = { ...windowWith([chatTab(failed)]) }

    hostLists([])

    expect(readOutbox(failed)).toHaveLength(1)
    expect(isNoteInFlight(NOTE_KEY)).toBe(true)
  })
})

function startFailedLaunch(): string {
  return startStructuredAgentLaunch(WT, 'codex', {
    prompt: 'review notes',
    carriedNoteKeys: [NOTE_KEY]
  }).sessionId
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}
