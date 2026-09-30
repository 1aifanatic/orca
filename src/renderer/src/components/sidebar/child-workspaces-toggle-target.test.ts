import { describe, expect, it } from 'vitest'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { resolveChildWorkspacesToggleGroupKey } from './child-workspaces-toggle-target'
import { worktree as baseWorktree } from './worktree-list-groups-test-fixtures'

type ToggleState = Parameters<typeof resolveChildWorkspacesToggleGroupKey>[0]
type HoverDocument = NonNullable<Parameters<typeof resolveChildWorkspacesToggleGroupKey>[1]>

function worktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return { ...baseWorktree, id, instanceId: `${id}-instance`, path: `/tmp/${id}`, ...overrides }
}

function lineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId ?? '',
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId ?? '',
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1
  }
}

function hoveredDocument(...hovered: Worktree[]): HoverDocument {
  const rows = hovered.map((row) => ({
    dataset: { worktreeId: row.id, worktreeHostIdentity: getWorktreeHostIdentity(row) }
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only length, item() and dataset from the hovered-row query.
  return {
    activeElement: null,
    querySelectorAll: () => ({ length: rows.length, item: (index: number) => rows[index] ?? null })
  } as unknown as HoverDocument
}

function toggleState(args: {
  worktrees: Worktree[]
  lineageById?: Record<string, WorktreeLineage>
  active?: Worktree
}): ToggleState {
  return {
    activeWorktreeId: args.active?.id ?? null,
    activeWorkspaceExecutionHostId: args.active?.hostId ?? null,
    worktreeLineageById: args.lineageById ?? {},
    worktreesByRepo: { [baseWorktree.repoId]: args.worktrees }
  }
}

const parent = worktree('parent')
const child = worktree('child')
const grandchild = worktree('grandchild')
const loner = worktree('loner')
const family = {
  worktrees: [parent, child, grandchild, loner],
  lineageById: { child: lineage(child, parent), grandchild: lineage(grandchild, child) }
}

describe('resolveChildWorkspacesToggleGroupKey', () => {
  it('toggles the hovered parent’s own children', () => {
    expect(resolveChildWorkspacesToggleGroupKey(toggleState(family), hoveredDocument(parent))).toBe(
      'lineage:parent'
    )
  })

  it('prefers the deepest hovered card, which may itself be a parent', () => {
    expect(
      resolveChildWorkspacesToggleGroupKey(toggleState(family), hoveredDocument(parent, child))
    ).toBe('lineage:child')
  })

  it('folds the parent when the target is a leaf child', () => {
    expect(
      resolveChildWorkspacesToggleGroupKey(toggleState(family), hoveredDocument(grandchild))
    ).toBe('lineage:child')
  })

  it('falls back to the active workspace when no card is hovered', () => {
    expect(
      resolveChildWorkspacesToggleGroupKey(
        toggleState({ ...family, active: parent }),
        hoveredDocument()
      )
    ).toBe('lineage:parent')
  })

  it('lets the hovered card win over the active one, even when it is in no lineage', () => {
    expect(
      resolveChildWorkspacesToggleGroupKey(
        toggleState({ ...family, active: parent }),
        hoveredDocument(loner)
      )
    ).toBeNull()
  })

  it('returns null without a hovered or active workspace', () => {
    expect(resolveChildWorkspacesToggleGroupKey(toggleState(family), hoveredDocument())).toBeNull()
  })

  it('ignores archived children', () => {
    const archivedChild = { ...child, isArchived: true }
    expect(
      resolveChildWorkspacesToggleGroupKey(
        toggleState({
          worktrees: [parent, archivedChild],
          lineageById: { child: lineage(archivedChild, parent) }
        }),
        hoveredDocument(parent)
      )
    ).toBeNull()
  })

  it('ignores a stale lineage record from an earlier instance', () => {
    const recreatedChild = { ...child, instanceId: 'child-recreated' }
    expect(
      resolveChildWorkspacesToggleGroupKey(
        toggleState({ worktrees: [parent, recreatedChild], lineageById: family.lineageById }),
        hoveredDocument(parent)
      )
    ).toBeNull()
  })

  it('uses the host-qualified key and ignores same-id rows on another host', () => {
    const remoteParent = worktree('parent', { hostId: 'ssh:box' })
    const localChild = worktree('child')
    const worktrees = [remoteParent, parent, localChild]
    const lineageById = { child: lineage(localChild, parent) }

    expect(
      resolveChildWorkspacesToggleGroupKey(
        toggleState({ worktrees, lineageById }),
        hoveredDocument(remoteParent)
      )
    ).toBeNull()
    expect(
      resolveChildWorkspacesToggleGroupKey(
        toggleState({ worktrees, lineageById }),
        hoveredDocument(parent)
      )
    ).toBe('lineage:parent')

    const remoteChild = worktree('child', { hostId: 'ssh:box' })
    expect(
      resolveChildWorkspacesToggleGroupKey(
        toggleState({
          worktrees: [remoteParent, remoteChild],
          lineageById: { child: lineage(remoteChild, remoteParent) },
          active: remoteChild
        }),
        hoveredDocument()
      )
    ).toBe(`lineage:${getWorktreeHostIdentity(remoteParent)}`)
  })
})
