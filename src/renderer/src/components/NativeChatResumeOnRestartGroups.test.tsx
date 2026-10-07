// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
import { getHostContextLabel } from '../../../shared/worktree/host-context-labels'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../shared/worktree/types'
import { ResumeOnRestartGroups } from './NativeChatResumeOnRestartGroups'
import { TooltipProvider } from './ui/tooltip'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLElement

function worktree(name: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: `repo-1::/repo/${name}`,
    instanceId: `instance-${name}`,
    repoId: 'repo-1',
    path: `/repo/${name}`,
    displayName: name,
    branch: `refs/heads/${name}-branch`,
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

function lineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId!,
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId!,
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1
  }
}

/** parent (1 chat) > child (2 chats), plus an unrelated root workspace. */
function seedTree(hosts: { parent?: ExecutionHostId; child?: ExecutionHostId } = {}) {
  // An explicit undefined is a row with no host id (older metadata).
  const parentHost = 'parent' in hosts ? hosts.parent : 'local'
  const parent = worktree('parent', { hostId: parentHost })
  const child = worktree('child', { hostId: 'child' in hosts ? hosts.child : 'local' })
  const other = worktree('other', { hostId: parentHost })
  useAppStore.setState({
    settings: getDefaultSettings(''),
    repos: [
      { id: 'repo-1', path: '/repo', displayName: 'orca', badgeColor: '#999999', addedAt: 1 }
    ],
    worktreesByRepo: { 'repo-1': [parent, child, other] },
    worktreeLineageById: { [child.id]: lineage(child, parent) }
  })
  return [
    candidate('in-child', child),
    candidate('in-parent', parent),
    candidate('also-in-child', child),
    candidate('in-other', other)
  ]
}

const onToggleSpy = vi.fn()

/** Owns the selection the way the dialog does, so group toggles show their effect. */
function Harness({
  candidates,
  initiallySelected,
  busy = false,
  failureFor
}: {
  candidates: ResumeCandidate[]
  initiallySelected?: string[]
  busy?: boolean
  failureFor?: (sessionId: string) => ResumeFailure | undefined
}): React.JSX.Element {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(initiallySelected ?? candidates.map((entry) => entry.sessionId))
  )
  return (
    <TooltipProvider>
      <ResumeOnRestartGroups
        candidates={candidates}
        listedAt={1_800_000_060_000}
        busy={busy}
        selected={selected}
        onToggle={(sessionId, checked) => {
          onToggleSpy(sessionId, checked)
          setSelected((current) => {
            const next = new Set(current)
            if (checked) {
              next.add(sessionId)
            } else {
              next.delete(sessionId)
            }
            return next
          })
        }}
        failureFor={failureFor}
      />
    </TooltipProvider>
  )
}

function render(props: React.ComponentProps<typeof Harness>): void {
  act(() => root.render(<Harness {...props} />))
}

function workspaceBox(name: string): HTMLElement {
  const box = container.querySelector<HTMLElement>(
    `[role="checkbox"][aria-label="Select all chats in ${name}"]`
  )
  if (!box) {
    throw new Error(`Missing workspace checkbox: ${name}`)
  }
  return box
}

function chatBox(sessionId: string): HTMLElement {
  const box = container.querySelector<HTMLElement>(
    `[role="checkbox"][aria-label*="Prompt ${sessionId}"]`
  )
  if (!box) {
    throw new Error(`Missing chat checkbox: ${sessionId}`)
  }
  return box
}

function rowOf(box: HTMLElement): HTMLElement {
  return box.closest('label')!
}

/** A row's grid cell: 1 is the checkbox column, 2 the indented content. */
function cell(row: HTMLElement, column: 1 | 2): HTMLElement {
  return row.querySelector<HTMLElement>(`:scope > :nth-child(${column})`)!
}

/** The workspace row's "x of y". */
function workspaceCount(name: string): string | undefined {
  return rowOf(workspaceBox(name)).querySelector('.tabular-nums')?.textContent ?? undefined
}

/** A project's header row, by the name it shows. */
function projectRow(name: string): HTMLElement {
  const row = [...container.querySelectorAll('section')]
    .map((section) => section.firstElementChild)
    .find((header) => header?.querySelector('.font-semibold')?.textContent === name)
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Missing project row: ${name}`)
  }
  return row
}

function projectBox(name: string): HTMLElement {
  return projectRow(name).querySelector<HTMLElement>('[role="checkbox"]')!
}

function projectCount(name: string): string | undefined {
  return projectRow(name).querySelector('.tabular-nums')?.textContent ?? undefined
}

/** Each row in list order, as kind:label@indent-of-its-content. */
function rowOutline(): string[] {
  return [...container.querySelectorAll<HTMLElement>('[role="checkbox"]')].map((box) => {
    const label = box.getAttribute('aria-label') ?? ''
    const row = rowOf(box)
    // Only a workspace band carries data-nested; a project header is the other band.
    if (row.parentElement?.tagName === 'SECTION' && !row.hasAttribute('data-nested')) {
      return `project:${/^Select all chats in (.+)$/.exec(label)?.[1]}`
    }
    const workspace = /^Select all chats in (.+)$/.exec(label)?.[1]
    if (workspace) {
      const content = cell(rowOf(box), 2)
      return `ws:${workspace}@${content.style.paddingLeft || '0px'}`
    }
    const indent = box.closest('ul')?.style.getPropertyValue('--resume-chat-indent')
    return `chat:${/Prompt ([\w-]+)/.exec(label)?.[1]}@${indent}`
  })
}

beforeEach(() => {
  onToggleSpy.mockReset()
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

it('lists every chat with its checkbox in the shared left column, indenting only the content', () => {
  const candidates = seedTree()
  render({ candidates })

  expect(rowOutline()).toEqual([
    'project:orca',
    'ws:parent@0px',
    'chat:in-parent@20px',
    'ws:child@20px',
    'chat:in-child@40px',
    'chat:also-in-child@40px',
    'ws:other@0px',
    'chat:in-other@20px'
  ])
  for (const box of container.querySelectorAll<HTMLElement>('[role="checkbox"]')) {
    const row = rowOf(box)
    // The checkbox cell is the row's first grid column and is never indented.
    expect(row.classList.contains('grid-cols-[1.75rem_minmax(0,1fr)]')).toBe(true)
    expect(row.firstElementChild?.contains(box)).toBe(true)
    expect(cell(row, 1).style.paddingLeft).toBe('')
  }
})

it('heads each project with a checkbox row in the same left column', () => {
  render({ candidates: seedTree() })

  const header = projectRow('orca')
  expect(header.textContent).toBe('orca4 of 4')
  expect(header.classList.contains('grid-cols-[1.75rem_minmax(0,1fr)]')).toBe(true)
  expect(cell(header, 1).contains(projectBox('orca'))).toBe(true)
  expect(projectBox('orca').getAttribute('aria-label')).toBe('Select all chats in orca')
})

// The grouped-list pattern: tinted header bands with a line above and below, hairlines between chats.
it('draws project and workspace bands, and hairlines only between chats', () => {
  render({ candidates: seedTree() })

  const project = projectRow('orca')
  expect(project.classList.contains('border-t')).toBe(true)
  expect(project.classList.contains('border-border')).toBe(true)
  expect(project.className).toContain(
    'bg-[color-mix(in_srgb,var(--foreground)_5%,var(--worktree-sidebar-accent))]'
  )
  for (const [name, nested] of [
    ['parent', 'false'],
    ['child', 'true'],
    ['other', 'false']
  ] as const) {
    const band = rowOf(workspaceBox(name))
    expect(band.classList.contains('border-y')).toBe(true)
    expect(band.classList.contains('border-border')).toBe(true)
    expect(band.classList.contains('bg-worktree-sidebar-accent')).toBe(true)
    expect(band.getAttribute('data-nested')).toBe(nested)
    expect(band.querySelector('.font-semibold')?.textContent).toBe(name)
  }
  for (const box of container.querySelectorAll<HTMLElement>(
    '[role="checkbox"][aria-label^="Resume"]'
  )) {
    const item = box.closest('li')!
    // The band above the first chat is its separator; later chats get a hairline.
    expect(item.classList.contains('not-first:border-t')).toBe(true)
    expect(item.classList.contains('border-worktree-sidebar-border')).toBe(true)
  }
  expect(container.querySelector('.rounded-md, .rounded-sm, .rounded-lg')).toBeNull()
})

it('selects every eligible chat in a project, nested workspaces included', () => {
  const candidates = seedTree()
  const mobile = worktree('mobile', { repoId: 'repo-2', id: 'repo-2::/mobile/mobile' })
  useAppStore.setState((state) => ({
    repos: [
      ...state.repos,
      {
        id: 'repo-2',
        path: '/mobile',
        displayName: 'orca-mobile',
        badgeColor: '#999999',
        addedAt: 1
      }
    ],
    worktreesByRepo: { ...state.worktreesByRepo, 'repo-2': [mobile] }
  }))
  const stuck: ResumeFailure = {
    ...candidates[3]!,
    failedAt: 1_800_000_030_000,
    outcome: 'refused',
    reason: 'agent_session_restart_work_superseded',
    retryable: false
  }
  render({
    candidates: [...candidates, candidate('in-mobile', mobile)],
    initiallySelected: ['in-parent', 'in-child', 'also-in-child', 'in-mobile'],
    failureFor: (sessionId) => (sessionId === 'in-other' ? stuck : undefined)
  })
  expect(projectBox('orca').getAttribute('aria-checked')).toBe('true')
  expect(projectCount('orca')).toBe('3 of 3')

  act(() => chatBox('also-in-child').click())
  expect(projectBox('orca').getAttribute('aria-checked')).toBe('mixed')
  expect(projectCount('orca')).toBe('2 of 3')

  onToggleSpy.mockClear()
  act(() => projectBox('orca').click())
  expect(chatBox('also-in-child').getAttribute('aria-checked')).toBe('true')
  expect(projectCount('orca')).toBe('3 of 3')

  act(() => projectBox('orca').click())
  expect(projectBox('orca').getAttribute('aria-checked')).toBe('false')
  for (const id of ['in-parent', 'in-child', 'also-in-child']) {
    expect(chatBox(id).getAttribute('aria-checked')).toBe('false')
  }
  // Never the unretryable chat, never another project's.
  const touched = onToggleSpy.mock.calls.map(([sessionId]) => sessionId)
  expect(touched).not.toContain('in-other')
  expect(touched).not.toContain('in-mobile')
  expect(chatBox('in-mobile').getAttribute('aria-checked')).toBe('true')
  expect(projectCount('orca-mobile')).toBe('1 of 1')
})

it('shows the branch for a git worktree, muted after its name', () => {
  render({ candidates: seedTree() })

  const content = rowOf(workspaceBox('parent')).children[1]!
  expect(content.textContent).toContain('parentparent-branch')
  const branch = [...content.querySelectorAll('span')].find(
    (span) => span.textContent === 'parent-branch'
  )
  expect(branch?.classList.contains('text-muted-foreground')).toBe(true)
})

it('covers nested child workspaces with a tri-state workspace checkbox', () => {
  render({ candidates: seedTree() })
  expect(workspaceBox('parent').getAttribute('aria-checked')).toBe('true')
  expect(workspaceCount('parent')).toBe('3 of 3')

  act(() => chatBox('in-child').click())
  expect(workspaceBox('parent').getAttribute('aria-checked')).toBe('mixed')
  expect(workspaceCount('parent')).toBe('2 of 3')
  expect(workspaceBox('child').getAttribute('aria-checked')).toBe('mixed')
  expect(workspaceCount('child')).toBe('1 of 2')
  expect(workspaceBox('other').getAttribute('aria-checked')).toBe('true')

  // Partly selected: ticking selects everything it covers, child workspace included.
  act(() => workspaceBox('parent').click())
  expect(chatBox('in-child').getAttribute('aria-checked')).toBe('true')
  expect(workspaceCount('parent')).toBe('3 of 3')

  act(() => workspaceBox('parent').click())
  expect(workspaceBox('parent').getAttribute('aria-checked')).toBe('false')
  expect(workspaceCount('parent')).toBe('0 of 3')
  for (const id of ['in-parent', 'in-child', 'also-in-child']) {
    expect(chatBox(id).getAttribute('aria-checked')).toBe('false')
  }
  expect(chatBox('in-other').getAttribute('aria-checked')).toBe('true')
})

it('selects a whole row by clicking anywhere on it', () => {
  render({ candidates: seedTree(), initiallySelected: [] })

  act(() => cell(rowOf(workspaceBox('child')), 2).click())
  expect(chatBox('in-child').getAttribute('aria-checked')).toBe('true')
  expect(chatBox('also-in-child').getAttribute('aria-checked')).toBe('true')

  act(() => cell(rowOf(chatBox('in-other')), 2).click())
  expect(chatBox('in-other').getAttribute('aria-checked')).toBe('true')
})

it('leaves a failure a retry cannot fix out of its workspace checkbox', () => {
  const candidates = seedTree()
  const stuck: ResumeFailure = {
    ...candidates[0]!,
    failedAt: 1_800_000_030_000,
    outcome: 'refused',
    reason: 'agent_session_restart_work_superseded',
    retryable: false
  }
  render({
    candidates,
    initiallySelected: ['in-parent'],
    failureFor: (sessionId) => (sessionId === 'in-child' ? stuck : undefined)
  })

  expect(chatBox('in-child').hasAttribute('disabled')).toBe(true)
  expect(workspaceCount('child')).toBe('0 of 1')
  expect(workspaceCount('parent')).toBe('1 of 2')

  act(() => workspaceBox('parent').click())
  expect(onToggleSpy.mock.calls.map(([sessionId]) => sessionId)).not.toContain('in-child')
  expect(chatBox('in-child').getAttribute('aria-checked')).toBe('false')
  expect(workspaceBox('parent').getAttribute('aria-checked')).toBe('true')
})

it('disables a workspace checkbox with nothing it could select', () => {
  const candidates = seedTree()
  const stuck = (sessionId: string): ResumeFailure => ({
    ...candidates.find((entry) => entry.sessionId === sessionId)!,
    failedAt: 1_800_000_030_000,
    outcome: 'refused',
    reason: 'agent_session_restart_work_superseded',
    retryable: false
  })
  render({
    candidates,
    initiallySelected: [],
    failureFor: (sessionId) => (sessionId === 'in-other' ? stuck(sessionId) : undefined)
  })

  expect(workspaceBox('other').hasAttribute('disabled')).toBe(true)
  expect(workspaceCount('other')).toBeUndefined()
})

it('disables every checkbox while a resume runs', () => {
  render({ candidates: seedTree(), busy: true })

  const boxes = [...container.querySelectorAll('[role="checkbox"]')]
  expect(boxes).toHaveLength(8)
  for (const box of boxes) {
    expect(box.hasAttribute('disabled')).toBe(true)
  }
})

it('names the machine of a single-host SSH offer', () => {
  const remote: ExecutionHostId = 'ssh:build-server'
  render({ candidates: seedTree({ parent: remote, child: remote }) })

  const label = getHostContextLabel(remote)
  for (const name of ['parent', 'child', 'other']) {
    expect(rowOf(workspaceBox(name)).textContent).toContain(label)
  }
})

// A target saved through Add SSH target gets a generated id; the sidebar names it by its label.
it('names an SSH machine by its saved name, not its target id', () => {
  const targetId = 'ssh-1728291234567-abc12d'
  const remote: ExecutionHostId = `ssh:${targetId}`
  const candidates = seedTree({ parent: remote, child: remote })
  useAppStore.setState({ sshTargetLabels: new Map([[targetId, 'devbox']]) })
  render({ candidates })

  const row = rowOf(workspaceBox('parent')).textContent
  expect(row).toContain('devbox')
  expect(row).not.toContain(targetId)
})

it('names hosts only when the machine is not obvious', () => {
  render({ candidates: seedTree() })
  const local = getHostContextLabel('local')
  expect(container.textContent).not.toContain(local)

  act(() => root.unmount())
  root = createRoot(container)
  const remote: ExecutionHostId = 'ssh:build-server'
  render({ candidates: seedTree({ parent: 'local', child: remote }) })
  expect(rowOf(workspaceBox('parent')).textContent).toContain(local)
  expect(rowOf(workspaceBox('child')).textContent).toContain(getHostContextLabel(remote))
})

it('names a workspace the store does not know by its id, with the kind the host recorded', () => {
  const unknown: ResumeCandidate = {
    ...candidate('lost', worktree('gone')),
    workspaceId: 'folder:missing-folder',
    workspaceKind: 'folder'
  }
  render({ candidates: [unknown] })

  const row = rowOf(workspaceBox('folder:missing-folder'))
  expect(row.textContent).toContain('folder:missing-folder')
  expect(row.querySelector('svg.lucide-folder')).not.toBeNull()
  expect(chatBox('lost').getAttribute('aria-label')).toContain('in folder:missing-folder')
})

// Its project is unknown too: a nameless "Select all chats in " checkbox would help no one.
it('gives workspaces the store cannot place no project row, leaving them to Select all', () => {
  const candidates = seedTree()
  const unknown: ResumeCandidate = {
    ...candidate('lost', worktree('gone')),
    workspaceId: 'folder:missing-folder',
    workspaceKind: 'folder'
  }
  render({ candidates: [...candidates, unknown] })

  expect(rowOutline()).toEqual([
    'project:orca',
    'ws:parent@0px',
    'chat:in-parent@20px',
    'ws:child@20px',
    'chat:in-child@40px',
    'chat:also-in-child@40px',
    'ws:other@0px',
    'chat:in-other@20px',
    'ws:folder:missing-folder@0px',
    'chat:lost@20px'
  ])
  expect(container.querySelector('[aria-label="Select all chats in "]')).toBeNull()
  const [, unplaced] = container.querySelectorAll('section')
  expect(unplaced?.firstElementChild).toBe(rowOf(workspaceBox('folder:missing-folder')))
  expect(projectCount('orca')).toBe('4 of 4')
})

// Why: the sidebar nests a child only under a parent on its own host; no host id matches only none.
it.each([
  ['both local', 'local', 'local', true],
  ['neither with a host id', undefined, undefined, true],
  ['parent without a host id, child local', undefined, 'local', false],
  ['parent local, child without a host id', 'local', undefined, false]
] as const)(
  '%s: nests the child exactly as the sidebar does',
  (_, parentHost, childHost, nests) => {
    const candidates = seedTree({ parent: parentHost, child: childHost })
    render({ candidates })

    expect(rowOutline()).toContain(nests ? 'ws:child@20px' : 'ws:child@0px')
    expect(workspaceCount('parent')).toBe(nests ? '3 of 3' : '1 of 1')
    expect(container.querySelectorAll('[role="checkbox"][aria-label^="Resume"]')).toHaveLength(4)
  }
)

it('lists every chat when workspace lineage loops', () => {
  const a = worktree('a')
  const b = worktree('b')
  useAppStore.setState({
    settings: getDefaultSettings(''),
    worktreesByRepo: { 'repo-1': [a, b] },
    worktreeLineageById: { [a.id]: lineage(a, b), [b.id]: lineage(b, a) }
  })
  render({ candidates: [candidate('in-a', a), candidate('in-b', b)] })

  expect(chatBox('in-a')).toBeTruthy()
  expect(chatBox('in-b')).toBeTruthy()
})
