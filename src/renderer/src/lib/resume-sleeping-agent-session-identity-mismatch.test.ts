// A sleeping record whose saved owner is another agent gets one visible refusal on automatic
// wake and is then consumed like a launched record, instead of re-toasting on every activation.
// A record whose pane is still preserved is left for that pane's cold restore, which keeps it.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  toast: { message: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() }
}))

import { toast } from 'sonner'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { AGENT_RESUME_IDENTITY_DISCARDED_ERROR } from '../../../shared/agent-resume-identity'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { makeTab, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const WT = 'repo-1::/local/wt'
const OTHER_WT = 'repo-1::/local/other'
const LEAF = '11111111-1111-4111-8111-111111111111'

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> & { paneKey: string }
): SleepingAgentSessionRecord {
  return {
    worktreeId: WT,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'codex-owned', resumeIdentity: { agent: 'codex' } },
    prompt: 'finish the task',
    state: 'working',
    origin: 'worktree-sleep',
    capturedAt: 1,
    updatedAt: 1,
    connectionId: null,
    ...overrides
  }
}

function seed(
  records: SleepingAgentSessionRecord[],
  extra: Partial<ReturnType<typeof useAppStore.getState>> = {}
): void {
  useAppStore.setState({
    repos: [{ ...TEST_REPO, id: 'repo-1', path: '/local' }],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: WT, repoId: 'repo-1', path: '/local/wt' }),
        makeWorktree({ id: OTHER_WT, repoId: 'repo-1', path: '/local/other' })
      ]
    },
    tabsByWorktree: {},
    sleepingAgentSessionsByPaneKey: Object.fromEntries(records.map((r) => [r.paneKey, r])),
    ...extra
  })
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear()
})

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

it('refuses a mismatched record once, consumes it, and leaves every other record alone', () => {
  const mismatched = makeRecord({ paneKey: 'tab-1:leaf-1', tabId: 'tab-1' })
  const owned = makeRecord({
    paneKey: 'tab-2:leaf-1',
    tabId: 'tab-2',
    providerSession: { key: 'session_id', id: 'claude-owned', resumeIdentity: { agent: 'claude' } }
  })
  const elsewhere = makeRecord({ paneKey: 'tab-3:leaf-1', tabId: 'tab-3', worktreeId: OTHER_WT })
  seed([mismatched, owned, elsewhere])

  expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(1)
  expect(vi.mocked(toast.error).mock.calls).toEqual([[AGENT_RESUME_IDENTITY_DISCARDED_ERROR]])
  expect(useAppStore.getState().sleepingAgentSessionsByPaneKey).toEqual({
    [elsewhere.paneKey]: elsewhere
  })
  expect(useAppStore.getState().tabsByWorktree[WT]).toHaveLength(1)

  expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)
  expect(toast.error).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().tabsByWorktree[WT]).toHaveLength(1)
})

it('leaves a mismatched record with a preserved pane to that pane, which keeps it', () => {
  const paneKey = makePaneKey('tab-1', LEAF)
  const record = makeRecord({ paneKey, tabId: 'tab-1', origin: 'quit' })
  seed([record], {
    activeWorktreeId: WT,
    tabsByWorktree: { [WT]: [makeTab({ id: 'tab-1', worktreeId: WT })] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-1' }
      }
    }
  })

  expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)
  expect(toast.error).not.toHaveBeenCalled()
  expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBe(record)
})
