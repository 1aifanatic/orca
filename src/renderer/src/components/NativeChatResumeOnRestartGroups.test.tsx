// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
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

// An older parent whose metadata carries no host, as the sidebar still nests children under.
const parent = worktree('parent')
const child = worktree('child', { hostId: 'local' })

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

const candidates = [
  candidate('in-child', child),
  candidate('in-parent', parent),
  candidate('also-in-child', child)
]

function render(newCardStyle: boolean): void {
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

for (const newCardStyle of [false, true]) {
  it(`shows every offered chat inside its sidebar card, the child nested (${newCardStyle ? 'new' : 'legacy'} cards)`, () => {
    render(newCardStyle)

    const checkboxes = [...container.querySelectorAll('[role="checkbox"]')]
    expect(checkboxes.map((box) => box.getAttribute('aria-checked'))).toEqual([
      'true',
      'true',
      'true'
    ])
    const parentCard = cardTitled('parent')
    const childCard = cardTitled('child')
    expect(parentCard.contains(childCard)).toBe(true)
    expect(childCard.textContent).toContain('Prompt in-child')
    expect(childCard.textContent).toContain('Prompt also-in-child')
    // Why: a legacy child sits one sidebar step (14px) in, as its own lineage depth puts it there.
    expect(childCard.parentElement?.style.paddingLeft ?? '').toBe(newCardStyle ? '' : '14px')
  })
}
