import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../shared/worktree/types'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = []
let settings: Partial<GlobalSettings> | null = null

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      deleteStateByWorktreeId: {},
      fetchHostedReviewForBranch,
      fetchIssue,
      fetchLinearIssue,
      gitConflictOperationByWorktree: {},
      hostedReviewCache: {},
      issueCache: {},
      linearIssueCache: {},
      openModal,
      projectGroups: [],
      remoteBranchConflictByWorktreeId: {},
      settings,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      updateWorktreeMeta,
      worktreeCardProperties
    })
}))

vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'idle'
}))

vi.mock('./use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: () => null
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope',
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu'
}))

import WorktreeCard from './WorktreeCard'

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#999999',
    addedAt: 1
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/worktrees/child',
    repoId: 'repo-1',
    path: '/repo/worktrees/child',
    displayName: 'Child workspace',
    branch: 'child-workspace',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

describe('WorktreeCard lineage indicators', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = []
    settings = null
  })

  it('does not render parent lineage badge copy on workspace cards', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).not.toContain('Parent workspace')
    expect(markup).not.toContain('parent:')
    expect(markup).not.toContain('from master')
    expect(markup).not.toContain('Missing parent')
    expect(markup).toContain('overflow-hidden')
  })

  it('keeps the child workspace toggle chip', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree()}
        repo={makeRepo()}
        isActive={false}
        lineageChildCount={1}
        lineageCollapsed={false}
        onLineageToggle={vi.fn()}
      />
    )

    expect(markup).toContain('aria-label="Hide 1 child workspace"')
    expect(markup).toContain('1 child')
    expect(markup).not.toContain('Parent workspace')
  })

  // Why: read-only cards keep the status lane, so legacy children keep the sidebar's outdent.
  const OUTDENT = '-ml-[1.125rem] mt-1.5 w-[calc(100%+1.125rem)] space-y-1'
  const STYLES = {
    legacy: {},
    compact: { compactWorktreeCards: true },
    new: { experimentalNewWorktreeCardStyle: true }
  }
  it.each([
    ['legacy', false, OUTDENT],
    ['compact', false, OUTDENT],
    ['new', false, 'mt-1.5 space-y-1'],
    ['legacy', true, OUTDENT],
    ['compact', true, OUTDENT],
    ['new', true, 'mt-1.5 space-y-1']
  ] as const)(
    '%s card, read-only %s: lineage children list classes',
    (style, readOnly, expectedClasses) => {
      settings = STYLES[style]
      // Why: status is a fixed card property, so every live card has the lane.
      worktreeCardProperties = ['status']
      const markup = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree()}
          repo={makeRepo()}
          isActive={false}
          readOnly={readOnly}
          lineageChildren={<span data-testid="child">child</span>}
        />
      )

      const listClasses = /<div class="([^"]*)"[^>]*><span data-testid="child">/.exec(markup)?.[1]
      expect(listClasses?.split(' ').toSorted()).toEqual(expectedClasses.split(' ').toSorted())
    }
  )
})
