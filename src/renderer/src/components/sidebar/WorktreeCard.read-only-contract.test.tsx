// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { issueCacheKey } from '@/store/github/cache-identity'
import type WorktreeCardComponent from './WorktreeCard'

const activateWorktreeFromSidebar = vi.hoisted(() => vi.fn())
const callbacks = {
  onActivate: vi.fn(),
  onWorktreeCardClick: vi.fn(),
  onImmediateActivate: vi.fn(),
  onSelectionGesture: vi.fn(() => false),
  onContextMenuSelect: vi.fn(() => []),
  onAssignWorkspaceStatus: vi.fn(),
  onCardDragStart: vi.fn(),
  onCardDragEnd: vi.fn(),
  onLineageToggle: vi.fn()
}

const ALL_CARD_PROPERTIES: WorktreeCardProperty[] = [
  'status',
  'unread',
  'ci',
  'branch',
  'issue',
  'linear-issue',
  'jira-issue',
  'pr',
  'automation',
  'cli',
  'comment',
  'ports',
  'inline-agents',
  'host'
]

let WorktreeCard: typeof WorktreeCardComponent
let settings: Partial<GlobalSettings> = {}
let deleteStateByWorktreeId: Record<string, unknown> = {}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      browserTabsByWorktree: {},
      createBrowserTab: vi.fn(),
      deleteFolderWorkspace: vi.fn(),
      deleteStateByWorktreeId,
      fetchHostedReviewForBranch: vi.fn(),
      fetchIssue: vi.fn(),
      fetchLinearIssue: vi.fn(),
      gitConflictOperationByWorktree: {},
      hostedReviewCache: {},
      // Why a url: the details popovers only offer their open/copy actions for a linked item with one.
      issueCache: {
        [issueCacheKey(repo.path, repo.id, 7, settings, repo.connectionId, undefined, true)]: {
          data: { number: 7, title: 'Issue', state: 'open', url: 'https://example.com/7' },
          fetchedAt: Date.now()
        }
      },
      linearIssueCache: {},
      openModal: vi.fn(),
      openTaskPage: vi.fn(),
      projectGroups: [],
      ptyIdsByTabId: {},
      recordFeatureInteraction: vi.fn(),
      remoteBranchConflictByWorktreeId: {},
      removedSshTargetLabels: new Map(),
      renamingWorktreeId: null,
      runtimeEnvironments: [],
      runtimeStatusByEnvironmentId: new Map(),
      setActiveWorktree: vi.fn(),
      setRenamingWorktreeId: vi.fn(),
      settings,
      sshConnectionStates: new Map([['ssh-target-1', { status: 'disconnected' }]]),
      sshStateByEnvironment: new Map(),
      sshTargetLabels: new Map([['ssh-target-1', 'Remote target']]),
      sshTargetsHydrated: true,
      tabsByWorktree: {},
      updateWorktreeMeta: vi.fn(),
      workspacePortScan: {
        key: 'repo-1',
        result: {
          platform: 'darwin',
          scannedAt: 1,
          ports: [
            {
              id: '127.0.0.1:5173:1234',
              bindHost: '127.0.0.1',
              connectHost: '127.0.0.1',
              port: 5173,
              pid: 1234,
              processName: 'node',
              protocol: 'http',
              kind: 'workspace',
              owner: {
                worktreeId: 'repo-1::/repo/worktrees/full',
                repoId: 'repo-1',
                displayName: 'Full',
                path: '/repo/worktrees/full',
                confidence: 'cwd'
              }
            }
          ]
        }
      },
      worktreesByRepo: {},
      worktreeCardProperties: ALL_CARD_PROPERTIES
    })
}))

// Why passthrough: popover and tooltip content then renders inline, so a hover that should not
// exist on a read-only card puts its buttons in the DOM where the sweep sees them.
vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/lib/sidebar-worktree-activation', () => ({ activateWorktreeFromSidebar }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'working'
}))

vi.mock('./use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => true
}))

vi.mock('./CacheTimer', () => ({
  default: () => <span data-testid="cache-timer" />,
  usePromptCacheCountdownStartedAt: (_worktreeId: string, active = true) => (active ? 1 : null)
}))

vi.mock('./useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: () => []
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: () => <button type="button" data-testid="inline-agents" />
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => (
    <div data-testid="context-menu-wrapper">{children}</div>
  ),
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'orca:test-close-context-menus',
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope',
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu'
}))

const INTERACTIVE =
  'button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"]), [role="button"], [draggable="true"]'

const CARD_STYLES: { name: string; settings: Partial<GlobalSettings> }[] = [
  { name: 'legacy', settings: { promptCacheTimerEnabled: true } },
  { name: 'compact', settings: { compactWorktreeCards: true, promptCacheTimerEnabled: true } },
  {
    name: 'new',
    settings: { experimentalNewWorktreeCardStyle: true, promptCacheTimerEnabled: true }
  }
]

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#999999',
  addedAt: 1,
  connectionId: 'ssh-target-1'
}

const worktree: Worktree = {
  id: 'repo-1::/repo/worktrees/full',
  repoId: 'repo-1',
  path: '/repo/worktrees/full',
  displayName: 'Full',
  branch: 'refs/heads/full',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  comment: 'a comment',
  linkedIssue: 7,
  linkedPR: 42,
  linkedLinearIssue: 'ENG-1',
  linkedGitLabMR: null,
  linkedGitLabIssue: null,
  firstAgentMessageRenameError: 'agent CLI said no',
  isArchived: false,
  isUnread: true,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

describe('WorktreeCard read-only contract', () => {
  let container: HTMLDivElement
  let root: Root

  beforeAll(async () => {
    WorktreeCard = (await import('./WorktreeCard')).default
  }, 20_000)

  beforeEach(() => {
    vi.clearAllMocks()
    deleteStateByWorktreeId = {}
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  /** Every feature on and every handler passed, so only the card itself can keep it inert. */
  function render(readOnly: boolean): HTMLElement {
    act(() => {
      root.render(
        <WorktreeCard
          worktree={worktree}
          repo={repo}
          isActive
          isActiveSurface
          isMultiSelected
          selectedWorktrees={[worktree]}
          revealHighlight
          isLineageDropTarget
          activationRowKey="row"
          renameRowKey="row"
          hostContextLabel="Remote target"
          flushSurface
          nativeDragEnabled
          lineageChildCount={2}
          lineageChildren={<span>children</span>}
          readOnly={readOnly}
          agentRows={
            <div data-testid="caller-rows">
              <button type="button">chat</button>
            </div>
          }
          {...callbacks}
        />
      )
    })
    const surface = container.querySelector<HTMLElement>('[data-worktree-card-surface="true"]')
    if (!surface) {
      throw new Error('card did not render')
    }
    return surface
  }

  function controlsOutsideCallerRows(): string[] {
    return [...container.querySelectorAll(INTERACTIVE)]
      .filter((element) => !element.closest('[data-testid="caller-rows"]'))
      .map((element) => element.getAttribute('aria-label') ?? element.outerHTML.slice(0, 80))
  }

  function liveState(): string[] {
    return [
      container.querySelector('[data-worktree-card-status-slot]') && 'status',
      container.querySelector('[data-worktree-sleeping-dim]') && 'sleep dim',
      container.querySelector('[data-testid="cache-timer"]') && 'cache countdown',
      container.textContent?.includes('Queued for deletion') && 'delete overlay'
    ].filter((entry): entry is string => typeof entry === 'string')
  }

  for (const style of CARD_STYLES) {
    it(`${style.name} card: the same fixture is live without readOnly`, () => {
      settings = style.settings
      render(false)
      expect(controlsOutsideCallerRows().length).toBeGreaterThan(0)
      expect(liveState()).toContain('status')
      deleteStateByWorktreeId = { [worktree.id]: { isDeleting: true, phase: 'queued' } }
      render(false)
      expect(liveState()).toContain('delete overlay')
    })

    it(`${style.name} card: read-only has no control outside the caller's rows and no live state`, () => {
      settings = style.settings
      for (const deleting of [false, true]) {
        deleteStateByWorktreeId = deleting
          ? { [worktree.id]: { isDeleting: true, phase: 'queued' } }
          : {}
        const surface = render(true)
        act(() => {
          surface.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          surface.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        })

        expect(controlsOutsideCallerRows()).toEqual([])
        expect(liveState()).toEqual([])
        expect(container.querySelector('[data-testid="context-menu-wrapper"]')).toBeNull()
        expect(surface.getAttribute('data-worktree-card-active')).toBeNull()
        expect(activateWorktreeFromSidebar).not.toHaveBeenCalled()
        for (const callback of Object.values(callbacks)) {
          expect(callback).not.toHaveBeenCalled()
        }
      }
    })
  }
})
