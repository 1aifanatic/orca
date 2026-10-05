import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { markLiveCodexSessionsForRestart } from './codex-session-restart'

const ACCOUNT_A = 'account-a@example.com'
const ACCOUNT_B = 'account-b@example.com'
const originalWindow = (globalThis as { window?: typeof window }).window

/** Main's per-PTY record decides a recorded pane's notice; these pin both of its answers. */
describe('Codex account switch recheck against main', () => {
  beforeEach(() => {
    useAppStore.setState({
      settings: null as never,
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-1',
            ptyId: 'pty-1',
            worktreeId: 'wt1',
            title: 'orca-1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      pendingCodexPaneRestartIds: {},
      codexRestartNoticeByPtyId: {}
    })
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          inspectProcess: vi
            .fn()
            .mockResolvedValue({ foregroundProcess: 'codex', hasChildProcesses: false }),
          confirmForegroundProcess: vi.fn().mockResolvedValue(null)
        },
        codexAccounts: {
          ...originalWindow?.api?.codexAccounts,
          listRecordedPaneLanes: vi.fn().mockResolvedValue({ 'pty-1': 'host' }),
          listStalePanes: vi.fn().mockResolvedValue([])
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('clears an open notice and its queued restart once main reports the pane current', async () => {
    useAppStore.getState().markCodexRestartNotices([
      {
        ptyId: 'pty-1',
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B,
        previousAccountId: 'account-a',
        nextAccountId: 'account-b'
      }
    ])
    useAppStore.getState().queueCodexPaneRestarts(['pty-1'])

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_B,
      nextAccountLabel: 'account-c@example.com',
      previousAccountId: 'account-b',
      nextAccountId: 'account-c'
    })

    expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledWith({ ptyIds: ['pty-1'] })
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({})
  })

  it('falls back to the switch it was given when main cannot answer', async () => {
    vi.mocked(window.api.codexAccounts.listStalePanes).mockRejectedValue(new Error('ipc failed'))

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })
  })
})
