// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { worktreeCardTitleXSignature } from './worktree-card-title-geometry.test-support'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeStatus } from '@/lib/worktree-status'
import { issueCacheKey } from '@/store/github/cache-identity'

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

const INTERACTION_VARIANT =
  /(?:^|:)(?:hover|focus|focus-visible|focus-within|active|disabled|aria-invalid):/

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

let settings: Partial<GlobalSettings> = {}
let deleteStateByWorktreeId: Record<string, unknown> = {}
let activityStatus: WorktreeStatus = 'working'
let sleeping = true
let sshStatus: SshConnectionStatus = 'disconnected'
const onChatClick = vi.fn()

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
      sshConnectionStates: new Map([['ssh-target-1', { status: sshStatus }]]),
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
  useWorktreeActivityStatus: () => activityStatus
}))

vi.mock('./use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => sleeping
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
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope',
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu'
}))

import WorktreeCard from './WorktreeCard'

const INTERACTIVE =
  'button, a, input, textarea, select, [tabindex], [role="button"], [draggable="true"]'

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

  beforeEach(() => {
    vi.clearAllMocks()
    activityStatus = 'working'
    sleeping = true
    sshStatus = 'disconnected'
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
  function render(readOnly: boolean, overrides: Partial<Worktree> = {}): HTMLElement {
    act(() => {
      root.render(
        <WorktreeCard
          worktree={{ ...worktree, ...overrides }}
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
          lineageCollapsed
          lineageChildren={<span>children</span>}
          readOnly={readOnly}
          agentRows={
            <div data-testid="caller-rows">
              <button type="button" onClick={onChatClick}>
                chat
              </button>
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

  it.each([
    ['branch', null, null],
    ['GitHub review', 42, null],
    ['GitLab review', null, 43]
  ] as const)('%s: read-only uses the quiet sidebar glyph', (_, linkedPR, linkedGitLabMR) => {
    settings = { experimentalNewWorktreeCardStyle: true }
    const overrides = { linkedPR, linkedGitLabMR, isUnread: false }
    render(true, overrides)
    const readOnlyGlyph = container.querySelector('[data-worktree-card-status-slot] svg')?.outerHTML
    expect(readOnlyGlyph).toBeDefined()
    expect(liveState()).toEqual([])

    activityStatus = 'inactive'
    sleeping = false
    render(false, overrides)
    expect(container.querySelector('[data-worktree-card-status-slot] svg')?.outerHTML).toBe(
      readOnlyGlyph
    )
  })

  function controlsOutsideCallerRows(): string[] {
    return [...container.querySelectorAll(INTERACTIVE)]
      .filter((element) => !element.closest('[data-testid="caller-rows"]'))
      .map((element) => element.getAttribute('aria-label') ?? element.outerHTML.slice(0, 80))
  }

  // Why: the fixture is working, asleep and unread, so a lane drawn from live state shows it.
  function liveState(): string[] {
    const lane = container.querySelector('[data-worktree-card-status-slot]')
    const title = container.querySelector('[data-worktree-title-inline-rename]')
    return [
      /Working|Failed|Done/.test(lane?.textContent ?? '') && 'live status',
      lane?.querySelector(
        '[data-agent-working-spinner], .animate-spin, .bg-red-500, .bg-emerald-500'
      ) && 'live glyph',
      lane?.querySelector('.lucide-moon') && 'sleep glyph',
      lane?.querySelector('.lucide-bell, .text-amber-500, [data-worktree-unread-alert]') &&
        'unread glyph',
      title?.className.includes('font-semibold') && 'unread title',
      container.querySelector('[data-worktree-sleeping-dim]') && 'sleep dim',
      container.querySelector('[data-testid="cache-timer"]') && 'cache countdown',
      container.textContent?.includes('Queued for deletion') && 'delete overlay'
    ].filter((entry): entry is string => typeof entry === 'string')
  }

  for (const style of CARD_STYLES) {
    it.each([
      'connected',
      'disconnected',
      'connecting',
      'error',
      'auth-failed',
      'reconnection-failed'
    ] as const)(
      `${style.name} card: %s SSH identity matches the live sidebar without controls`,
      (status) => {
        settings = style.settings
        sshStatus = status
        activityStatus = 'inactive'
        sleeping = false
        const overrides = { isUnread: false, firstAgentMessageRenameError: null }
        render(false, overrides)
        const liveIdentity = container.querySelector('[data-ssh-target-label]')
        expect(liveIdentity).not.toBeNull()
        const liveClasses = [...(liveIdentity?.classList ?? [])]
          .filter((name) => name !== 'cursor-pointer' && !INTERACTION_VARIANT.test(name))
          .toSorted()
        const liveGlyph = liveIdentity?.querySelector('svg')?.outerHTML
        const liveSignature = worktreeCardTitleXSignature(
          container.querySelector('[data-worktree-title-inline-rename]'),
          container
        )
        render(true, overrides)
        const identity = container.querySelector('[data-ssh-target-label]')
        expect(
          worktreeCardTitleXSignature(
            container.querySelector('[data-worktree-title-inline-rename]'),
            container
          )
        ).toEqual(liveSignature)
        expect(identity?.tagName).toBe('SPAN')
        expect(
          [...(identity?.classList ?? [])].filter((name) => INTERACTION_VARIANT.test(name))
        ).toEqual([])
        expect(
          [...(identity?.classList ?? [])].filter((name) => name !== 'cursor-default').toSorted()
        ).toEqual(liveClasses)
        expect(identity?.querySelector('svg')?.outerHTML).toBe(liveGlyph)
        expect(identity?.textContent).toContain('Remote target')
        expect(controlsOutsideCallerRows()).toEqual([])
        expect(identity?.hasAttribute('aria-describedby')).toBe(false)
      }
    )

    it(`${style.name} card: the same fixture is live without readOnly`, () => {
      settings = style.settings
      render(false)
      expect(controlsOutsideCallerRows().length).toBeGreaterThan(0)
      expect(liveState()).toContain('live status')
      expect(liveState()).toContain('unread title')
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
        expect(container.querySelector('[data-worktree-card-status-slot]')).not.toBeNull()
        expect(container.textContent).toContain('2 children')
        expect(container.querySelector('.-rotate-90')).toBeNull()
        expect(container.querySelector('[data-testid="context-menu-wrapper"]')).toBeNull()
        expect(surface.getAttribute('data-worktree-card-active')).toBeNull()
        expect(surface.getAttribute('data-worktree-card-selected')).toBeNull()
        expect(surface.getAttribute('data-worktree-lineage-drop-target')).toBeNull()
        expect(surface.className).not.toContain('reveal-highlight')
        expect(activateWorktreeFromSidebar).not.toHaveBeenCalled()
        for (const callback of Object.values(callbacks)) {
          expect(callback).not.toHaveBeenCalled()
        }
        const chat = container.querySelector('[data-testid="caller-rows"] button')
        act(() => chat?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
        expect(onChatClick).toHaveBeenCalledTimes(deleting ? 2 : 1)
      }
    })

    it(`${style.name} card: activity changes never enter the quiet status lane`, () => {
      settings = style.settings
      for (const status of ['working', 'failed', 'done', 'inactive'] as const) {
        activityStatus = status
        render(true)
        expect(liveState()).toEqual([])
        expect(controlsOutsideCallerRows()).toEqual([])
      }
    })
  }
})
