// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import { ResumeOnRestartGroups } from './NativeChatResumeOnRestartGroups'
import { TooltipProvider } from './ui/tooltip'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement

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
  hosts: { parent?: ExecutionHostId; child?: ExecutionHostId } = { parent: 'local', child: 'local' }
): void {
  const parent = worktree('parent', { hostId: hosts.parent })
  const child = worktree('child', { hostId: hosts.child })
  const candidates = [
    candidate('in-child', child),
    candidate('in-parent', parent),
    candidate('also-in-child', child)
  ]
  useAppStore.setState({
    settings: { ...getDefaultSettings(''), experimentalNewWorktreeCardStyle: newCardStyle },
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

// Title step, child minus parent = list margin + wrapper inset + 7px (ml-1, border, padding) + the
// child's status lane. Sidebar legacy cards: -18 + 14 + 7 + 18 = 21px (35px at depth 2). A
// read-only card has no lane and no outdent: 0 + 14 + 7 = 21px.
it('steps a legacy child in as far as the sidebar does, with no status lane', () => {
  render(false)

  const childCard = cardTitled('child')
  const wrapper = childCard.parentElement
  expect(container.querySelector('[data-worktree-card-status-slot]')).toBeNull()
  expect(wrapper?.style.paddingLeft).toBe('14px')
  expect(wrapper?.parentElement?.className.split(' ').toSorted()).toEqual(['mt-1.5', 'space-y-1'])
})

it('keeps the new card style geometry', () => {
  render(true)

  const childCard = cardTitled('child')
  expect(checkedBoxes()).toEqual(['true', 'true', 'true'])
  expect(cardTitled('parent').contains(childCard)).toBe(true)
  expect(childCard.parentElement?.style.paddingLeft).toBe('')
  expect(childCard.closest<HTMLElement>('[data-worktree-lineage-children]')?.style.marginLeft).toBe(
    '14px'
  )
})
