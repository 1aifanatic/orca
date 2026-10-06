// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
import type { SshConnectionStatus } from '../../../shared/ssh-types'
import { worktreeCardTitleXSignature } from './sidebar/worktree-card-title-geometry.test-support'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import { ResumeOnRestartGroups } from './NativeChatResumeOnRestartGroups'
import { TooltipProvider } from './ui/tooltip'
import {
  renderWorktreeItemRow,
  type WorktreeItemRowContext
} from './sidebar/worktree-list/rows/item-row'
import { WORKTREE_ROW_DRAG_INITIAL_STATE } from './sidebar/worktree-list/drag/row-state'
import type { WorktreeItemRow } from './sidebar/worktree-list/listing/renderable-rows'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLElement
const liveRoots: { root: Root; element: HTMLElement }[] = []

function worktree(name: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: `repo-1::/repo/${name}`,
    instanceId: `instance-${name}`,
    repoId: 'repo-1',
    path: `/repo/${name}`,
    displayName: name,
    branch: `refs/heads/${name}`,
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

function candidate(sessionId: string, workspace: Worktree): ResumeCandidate {
  return {
    sessionId,
    workspaceId: workspace.id,
    agent: 'codex',
    trigger: 'quit',
    latestPrompt: `Prompt ${sessionId}`,
    recordedAt: 1_800_000_000_000,
    executionHostId: workspace.hostId ?? 'local',
    workspaceKind: 'git-worktree'
  }
}

function render(
  newCardStyle: boolean,
  hosts: { parent?: ExecutionHostId; child?: ExecutionHostId } = {
    parent: 'local',
    child: 'local'
  },
  compactCards = false,
  sshStatus?: SshConnectionStatus
): void {
  const parent = worktree('parent', { hostId: hosts.parent })
  const child = worktree('child', { hostId: hosts.child })
  const candidates = [
    candidate('in-child', child),
    candidate('in-parent', parent),
    candidate('also-in-child', child)
  ]
  useAppStore.setState({
    settings: {
      ...getDefaultSettings(''),
      experimentalNewWorktreeCardStyle: newCardStyle,
      compactWorktreeCards: compactCards
    },
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'orca',
        badgeColor: '#999999',
        addedAt: 1,
        connectionId: sshStatus ? 'build-server' : undefined
      }
    ],
    sshConnectionStates: new Map(
      sshStatus
        ? [
            [
              'build-server',
              {
                targetId: 'build-server',
                status: sshStatus,
                error: null,
                reconnectAttempt: 0,
                remotePlatform: 'linux'
              }
            ]
          ]
        : []
    ),
    sshTargetLabels: new Map([['build-server', 'build-server']]),
    worktreesByRepo: { 'repo-1': [parent, child] },
    worktreeLineageById: {
      [child.id]: {
        worktreeId: child.id,
        worktreeInstanceId: 'instance-child',
        parentWorktreeId: parent.id,
        parentWorktreeInstanceId: 'instance-parent',
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      }
    }
  })
  act(() =>
    root.render(
      <TooltipProvider>
        <ResumeOnRestartGroups
          candidates={candidates}
          listedAt={1_800_000_060_000}
          busy={false}
          selected={new Set(candidates.map((entry) => entry.sessionId))}
          onToggle={() => {}}
        />
      </TooltipProvider>
    )
  )
}

function cardTitled(title: string): HTMLElement {
  const card = [
    ...container.querySelectorAll<HTMLElement>('[data-worktree-card-surface="true"]')
  ].find(
    (surface) => surface.querySelector('[data-worktree-title-inline-rename]')?.textContent === title
  )
  if (!card) {
    throw new Error(`Missing card: ${title}`)
  }
  return card
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  for (const live of liveRoots.splice(0)) {
    act(() => live.root.unmount())
    live.element.remove()
  }
  useAppStore.setState(useAppStore.getInitialState(), true)
})

function checkedBoxes(): (string | null)[] {
  return [...container.querySelectorAll('[role="checkbox"]')].map((box) =>
    box.getAttribute('aria-checked')
  )
}

// Why: the sidebar nests a child only under a parent on its own host; no host id matches only none.
it.each([
  ['both local', 'local', 'local', true],
  ['neither with a host id', undefined, undefined, true],
  ['parent without a host id, child local', undefined, 'local', false],
  ['parent local, child without a host id', 'local', undefined, false]
] as const)(
  '%s: nests the child exactly as the sidebar does',
  (_, parentHost, childHost, nests) => {
    render(false, { parent: parentHost, child: childHost })

    expect(checkedBoxes()).toEqual(['true', 'true', 'true'])
    expect(cardTitled('parent').contains(cardTitled('child'))).toBe(nests)
    expect(cardTitled('child').textContent).toContain('Prompt in-child')
    expect(cardTitled('child').textContent).toContain('Prompt also-in-child')
  }
)

function titleXSignature(title: string, stopAt: Element): string[] {
  return worktreeCardTitleXSignature(
    cardTitled(title).querySelector('[data-worktree-title-inline-rename]'),
    stopAt
  )
}

function surfaceClasses(title: string): string[] {
  // Why: caller-owned chat rows change compact card height; borders and surfaces must still match.
  return [...cardTitled(title).classList]
    .filter((name) => /^(border($|-)|rounded-|bg-|ring-|shadow-)/.test(name))
    .toSorted()
}

function renderLiveSidebarRows(): HTMLElement {
  const state = useAppStore.getState()
  const [parent, child] = state.worktreesByRepo['repo-1'] ?? []
  const repo = state.repos[0]
  if (!parent || !child) {
    throw new Error('Missing sidebar fixture')
  }
  const ctx: WorktreeItemRowContext = {
    settings: state.settings,
    groupBy: 'repo',
    folderBackedProjectGroupIds: new Set(),
    groupKeyByRowKey: new Map(),
    groupIndexByRowKey: new Map(),
    agentSendTargetWorktreeId: null,
    worktreeDragState: WORKTREE_ROW_DRAG_INITIAL_STATE,
    nativeLineageDropTargetId: null,
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    currentWorktreeId: null,
    highlightedRevealRowKey: null,
    selectedWorktreeIds: new Set(),
    selectedWorktrees: [],
    getActiveSurfaceVariant: () => 'primary',
    getLineageToggleHandler: () => vi.fn(),
    onSelectionGesture: () => false,
    onContextMenuSelect: () => [],
    onImmediateActivate: vi.fn(),
    onRowClickCapture: vi.fn(),
    onRowPointerDown: vi.fn(),
    onCardDragStart: vi.fn(),
    onCardDragEnd: vi.fn()
  }
  const row = (workspace: Worktree, depth: number): WorktreeItemRow => ({
    type: 'item',
    rowKey: workspace.id,
    sectionKey: 'repo-1',
    worktree: workspace,
    repo,
    depth,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: true,
    lineageChildCount: depth === 0 ? 1 : 0,
    lineageGroupKey: depth === 0 ? 'parent' : undefined,
    lineageCollapsed: false
  })
  const live = document.createElement('div')
  document.body.append(live)
  const liveRoot = createRoot(live)
  act(() =>
    liveRoot.render(
      <TooltipProvider>
        {renderWorktreeItemRow(
          ctx,
          row(parent, 0),
          false,
          renderWorktreeItemRow(ctx, row(child, 1), true)
        )}
      </TooltipProvider>
    )
  )
  liveRoots.push({ root: liveRoot, element: live })
  return live
}

it.each(
  [
    { style: 'legacy', newCardStyle: false, compactCards: false },
    { style: 'compact', newCardStyle: false, compactCards: true },
    { style: 'new', newCardStyle: true, compactCards: false }
  ].flatMap((style) =>
    ([undefined, 'connected', 'disconnected'] as const).map((sshStatus) => ({
      ...style,
      sshStatus
    }))
  )
)(
  '$style/$sshStatus: places parent and child titles where the live sidebar does',
  ({ newCardStyle, compactCards, sshStatus }) => {
    render(
      newCardStyle,
      sshStatus ? { parent: 'ssh:build-server', child: 'ssh:build-server' } : undefined,
      compactCards,
      sshStatus
    )
    const dialogList = cardTitled('parent').parentElement?.parentElement
    if (!dialogList) {
      throw new Error('Missing dialog list')
    }
    const dialog = {
      parent: titleXSignature('parent', dialogList),
      child: titleXSignature('child', dialogList),
      parentSurface: surfaceClasses('parent'),
      childSurface: surfaceClasses('child')
    }
    const live = renderLiveSidebarRows()
    const liveContainer = container
    container = live
    const sidebar = {
      parent: titleXSignature('parent', live),
      child: titleXSignature('child', live),
      parentSurface: surfaceClasses('parent'),
      childSurface: surfaceClasses('child')
    }
    container = liveContainer

    expect(dialog.parent.length).toBeGreaterThan(3)
    expect(dialog).toEqual(sidebar)
    if (sshStatus) {
      const identity = cardTitled('parent').querySelector('[data-ssh-target-label="build-server"]')
      expect(identity?.tagName).toBe('SPAN')
      expect(cardTitled('parent').textContent).toContain('build-server')
      expect(identity?.matches('button, [tabindex], [role="button"]')).toBe(false)
      expect(dialog.parent).toContain('gaps-before: 1')
      if (sshStatus === 'connected') {
        expect(identity?.querySelector('svg')?.classList.contains('size-3')).toBe(true)
        expect(dialog.parent).toContain('before: size-3 width=24')
      } else if (newCardStyle || compactCards) {
        expect(identity?.querySelector('svg')?.classList.contains('size-2.5')).toBe(true)
      } else {
        expect(identity?.textContent).toContain('Connect')
      }
    }
  }
)

it('lays a read-only parent out with its status lane and passive child chip', () => {
  render(false)

  const parentCard = cardTitled('parent')
  expect(parentCard.querySelector('[data-worktree-card-status-slot]')).not.toBeNull()
  expect(parentCard.textContent).toContain('1 child')
  expect(parentCard.querySelector('button[aria-expanded]')).toBeNull()
})

it('counts only listed child workspaces in the passive chip', () => {
  render(false)
  const state = useAppStore.getState()
  const parent = state.worktreesByRepo['repo-1']?.[0]
  const childLineage = Object.values(state.worktreeLineageById)[0]
  if (!parent || !childLineage) {
    throw new Error('Missing lineage fixture')
  }
  const unlisted = worktree('unlisted', { hostId: 'local' })
  act(() =>
    useAppStore.setState({
      worktreesByRepo: { 'repo-1': [...(state.worktreesByRepo['repo-1'] ?? []), unlisted] },
      worktreeLineageById: {
        ...state.worktreeLineageById,
        [unlisted.id]: {
          ...childLineage,
          worktreeId: unlisted.id,
          worktreeInstanceId: 'instance-unlisted'
        }
      }
    })
  )
  expect(cardTitled('parent').textContent).toContain('1 child')
  expect(cardTitled('parent').textContent).not.toContain('2 children')
})

it.each([
  ['legacy', false, false, true],
  ['legacy, host disabled', false, false, false],
  ['compact', false, true, true],
  ['new', true, false, true],
  ['new, host disabled', true, false, false]
] as const)(
  '%s: keeps a remote folder identifiable when its host chip is enabled',
  async (_style, newCardStyle, compactCards, showHost) => {
    useAppStore.setState({
      settings: {
        ...getDefaultSettings(''),
        experimentalNewWorktreeCardStyle: newCardStyle,
        compactWorktreeCards: compactCards
      },
      worktreeCardProperties: showHost ? ['status', 'host'] : ['status'],
      folderWorkspaces: [
        {
          id: 'remote-folder',
          projectGroupId: 'folder-project',
          name: 'Remote folder',
          folderPath: '/remote/folder',
          connectionId: 'build-server',
          executionHostId: 'ssh:build-server',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 1,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const entry: ResumeCandidate = {
      ...candidate('folder-chat', worktree('folder')),
      workspaceId: 'folder:remote-folder',
      executionHostId: 'ssh:build-server',
      workspaceKind: 'folder'
    }
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ResumeOnRestartGroups
            candidates={[entry]}
            listedAt={entry.recordedAt}
            busy={false}
            selected={new Set([entry.sessionId])}
            onToggle={() => {}}
          />
        </TooltipProvider>
      )
    )
    const card = cardTitled('Remote folder')
    expect(card.textContent?.includes('build-server')).toBe(showHost && !compactCards)
    expect(card.querySelector('[data-ssh-target-label]')).toBeNull()
    expect(card.querySelector('button:not([role="checkbox"]), [tabindex]')).toBeNull()
  }
)
