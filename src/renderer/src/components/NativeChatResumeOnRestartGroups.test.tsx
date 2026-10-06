// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
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
    executionHostId: 'local',
    workspaceKind: 'git-worktree'
  }
}

function render(
  newCardStyle: boolean,
  hosts: { parent?: ExecutionHostId; child?: ExecutionHostId } = {
    parent: 'local',
    child: 'local'
  },
  compactCards = false
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
      { id: 'repo-1', path: '/repo', displayName: 'orca', badgeColor: '#999999', addedAt: 1 }
    ],
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

// Why: ancestor spacing and earlier flex items determine the title's horizontal offset.
const X_GEOMETRY = /^-?(m[lrx]?|p[lrx]?|gap|w|size|space-x)-/

function describeX(element: Element | null): string {
  if (!(element instanceof HTMLElement)) {
    return ''
  }
  const classes = [...element.classList].filter((name) => X_GEOMETRY.test(name)).toSorted()
  // Why the raw attribute: the DOM shim drops values like max(), which the card's padding uses.
  const styles = (element.getAttribute('style') ?? '')
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => /^(padding-left|margin-left|width):/.test(declaration))
  return [...classes, ...styles].join(' ')
}

function isRow(element: Element | null): boolean {
  const classes = element?.classList
  return (
    Boolean(classes && (classes.contains('flex') || classes.contains('inline-flex'))) &&
    !classes?.contains('flex-col')
  )
}

function titleXSignature(title: string, stopAt: Element): string[] {
  const titleElement = cardTitled(title).querySelector('[data-worktree-title-inline-rename]')
  const signature: string[] = []
  for (let node = titleElement; node && node !== stopAt; node = node.parentElement) {
    signature.push(describeX(node))
    // Why: only a row's earlier items (the status lane, chips) push the title sideways.
    if (!isRow(node.parentElement)) {
      continue
    }
    for (let before = node.previousElementSibling; before; before = before.previousElementSibling) {
      let box: Element | null = before
      while (box && describeX(box) === '' && box.firstElementChild) {
        box = box.firstElementChild
      }
      signature.push(`before: ${describeX(box)}`)
    }
  }
  // Why: a plain wrapper (context-menu trigger, sleep dim) moves nothing.
  return signature.filter((entry) => entry !== '' && entry !== 'before: ')
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

it.each([
  ['legacy', false, false],
  ['compact', false, true],
  ['new', true, false]
] as const)(
  '%s: places parent and child titles where the live sidebar does',
  (_style, newCardStyle, compactCards) => {
    render(newCardStyle, undefined, compactCards)
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
