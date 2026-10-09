// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { TabSessionSurfaceSwitchMenuItems } from './TabSessionSurfaceSwitchMenuItems'

const mocks = vi.hoisted(() => {
  const state: {
    subject: Record<string, unknown> | null
    move: { action: string; worktreeId: string } | null
    launchActionArgs: unknown[]
  } = { subject: null, move: null, launchActionArgs: [] }
  return {
    ...state,
    handleResumeInNewChat: vi.fn(),
    handleResumeInNewCli: vi.fn(),
    listSessions: vi.fn(),
    cancelListSessions: vi.fn(async () => {})
  }
})

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ settings: null }),
    { getState: () => ({}) }
  )
}))

vi.mock('./tab-session-history-switch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveTabSessionHistorySubject: () => mocks.subject,
  resolveTabSessionSwitch: () => mocks.move
}))

vi.mock('../right-sidebar/ai-vault-session-launch-actions', () => ({
  useAiVaultSessionLaunchActions: (args: unknown) => {
    mocks.launchActionArgs.push(args)
    return {
      handleResumeInNewChat: mocks.handleResumeInNewChat,
      handleResumeInNewCli: mocks.handleResumeInNewCli
    }
  }
}))

const CHAT_ROW: AiVaultSession = {
  id: 'row-1',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 'claude-session-1',
  title: 'Fix the build',
  cwd: '/repo/wt',
  branch: null,
  model: null,
  filePath: '/home/.claude/projects/repo/claude-session-1.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-10-08T00:00:00.000Z',
  messageCount: 2,
  totalTokens: 10,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: '',
  subagent: null,
  structuredSession: { sessionId: 'orca-chat-1', workspaceId: 'wt-1' }
}

const CHAT_SUBJECT = {
  kind: 'chat',
  sessionId: 'orca-chat-1',
  workspaceId: 'wt-1',
  workspacePath: '/repo/wt',
  executionHostId: 'local'
}

beforeEach(() => {
  mocks.subject = null
  mocks.move = null
  mocks.launchActionArgs = []
  mocks.handleResumeInNewChat.mockReset()
  mocks.handleResumeInNewCli.mockReset()
  mocks.listSessions.mockReset()
  mocks.listSessions.mockResolvedValue({
    sessions: [CHAT_ROW],
    issues: [],
    scannedAt: 'now'
  })
  Object.assign(window, {
    api: {
      aiVault: {
        listSessions: mocks.listSessions,
        cancelListSessions: mocks.cancelListSessions
      }
    }
  })
})

afterEach(cleanup)

async function renderItems(structuredSessionId?: string): Promise<void> {
  render(
    <TooltipProvider>
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <TabSessionSurfaceSwitchMenuItems
            tab={{ id: 'tab-1', worktreeId: 'wt-1', launchAgent: 'claude' }}
            structuredSessionId={structuredSessionId}
            leadingSeparator
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
  await act(async () => {})
}

describe('TabSessionSurfaceSwitchMenuItems', () => {
  it('looks nothing up and shows nothing for a tab without a history session', async () => {
    await renderItems()
    expect(mocks.listSessions).not.toHaveBeenCalled()
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('hides the move when the Session History gate withholds it', async () => {
    mocks.subject = CHAT_SUBJECT
    await renderItems('orca-chat-1')
    expect(mocks.listSessions).toHaveBeenCalled()
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('runs the Session History "Resume in New CLI" handler on the row, in the tab workspace', async () => {
    mocks.subject = CHAT_SUBJECT
    mocks.move = { action: 'resume-in-new-cli', worktreeId: 'wt-1' }
    await renderItems('orca-chat-1')

    expect(screen.getByRole('separator')).toBeTruthy()
    expect(screen.queryByText('Resume in New Native Chat')).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resume in New CLI' }))
    expect(mocks.handleResumeInNewCli).toHaveBeenCalledWith(CHAT_ROW, 'wt-1')
    expect(mocks.launchActionArgs.at(-1)).toMatchObject({
      activeWorktree: null,
      activeWorktreeId: 'wt-1'
    })
  })

  it('runs the Session History "Resume in New Native Chat" handler for a CLI tab', async () => {
    const cliRow = { ...CHAT_ROW, structuredSession: undefined }
    mocks.listSessions.mockResolvedValue({
      sessions: [cliRow],
      issues: [],
      scannedAt: 'now'
    })
    mocks.subject = {
      kind: 'cli',
      agent: 'claude',
      providerSessionId: 'claude-session-1',
      workspaceId: 'wt-1',
      workspacePath: '/repo/wt',
      executionHostId: 'local'
    }
    mocks.move = { action: 'resume-in-new-chat', worktreeId: 'wt-1' }
    await renderItems()

    expect(screen.queryByText('Resume in New CLI')).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resume in New Native Chat' }))
    expect(mocks.handleResumeInNewChat).toHaveBeenCalledWith(cliRow, 'wt-1')
  })

  it('cancels its lookup when the menu closes', async () => {
    mocks.subject = CHAT_SUBJECT
    mocks.listSessions.mockReturnValue(new Promise(() => {}))
    await renderItems('orca-chat-1')
    cleanup()
    expect(mocks.cancelListSessions).toHaveBeenCalledWith({
      requestToken: expect.any(String)
    })
  })
})
