import { useAppStore } from '@/store'
import type { Worktree } from '../../../../shared/worktree/types'
import { normalizeAbsolutePath } from '@/lib/terminal-path-normalization'
import { resolveExactWorktreeRoute } from '@/lib/worktree-owner-route'
import {
  resolveWorktreeOperationRouteResult,
  type WorktreeOperationRouteState
} from '@/lib/worktree-operation-route'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'

export type WorktreeRootPathLink = {
  id: string
  path: string
  executionHostId: ExecutionHostId
}

type WorktreeRootRecord = Pick<
  Worktree,
  'id' | 'repoId' | 'path' | 'hostId' | 'runtimeOwnerEnvironmentId'
>
type WorktreeRootPathState = WorktreeOperationRouteState & {
  worktreesByRepo: Record<string, readonly WorktreeRootRecord[]>
}
type WorktreeRootPathIndex = Map<string, WorktreeRootRecord[]>

const EMPTY_WORKTREE_ROOT_PATH_INDEX: WorktreeRootPathIndex = new Map()
const worktreeRootPathIndexCache = new WeakMap<
  WorktreeRootPathState['worktreesByRepo'],
  WorktreeRootPathIndex
>()

function isPathSeparator(value: string): boolean {
  return value === '/' || value === '\\'
}

function isDriveRoot(value: string): boolean {
  return /^[A-Za-z]:[\\/]$/.test(value)
}

export function normalizeWorktreeRootPathForTerminalLink(path: string): string {
  const normalizedAbsolutePath = normalizeAbsolutePath(path)
  if (normalizedAbsolutePath) {
    return normalizedAbsolutePath.normalized
  }

  let end = path.length
  while (end > 1 && isPathSeparator(path[end - 1])) {
    const candidate = path.slice(0, end)
    if (candidate === '/' || isDriveRoot(candidate)) {
      break
    }
    end -= 1
  }
  return path.slice(0, end)
}

function getWorktreeRootPathComparisonKey(path: string): string {
  const normalizedAbsolutePath = normalizeAbsolutePath(path)
  if (normalizedAbsolutePath) {
    return normalizedAbsolutePath.comparisonKey
  }
  return normalizeWorktreeRootPathForTerminalLink(path)
}

function getWorktreeRootPathIndex(
  worktreesByRepo: WorktreeRootPathState['worktreesByRepo'] | undefined
): WorktreeRootPathIndex {
  if (!worktreesByRepo) {
    return EMPTY_WORKTREE_ROOT_PATH_INDEX
  }

  const cachedIndex = worktreeRootPathIndexCache.get(worktreesByRepo)
  if (cachedIndex) {
    return cachedIndex
  }

  const index: WorktreeRootPathIndex = new Map()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      const comparisonKey = getWorktreeRootPathComparisonKey(worktree.path)
      const roots = index.get(comparisonKey) ?? []
      roots.push(worktree)
      index.set(comparisonKey, roots)
    }
  }

  worktreeRootPathIndexCache.set(worktreesByRepo, index)
  return index
}

function terminalFileSourceHost(
  state: WorktreeRootPathState,
  context: RuntimeFileOperationArgs | undefined
): ExecutionHostId {
  const target = getActiveRuntimeTarget(context?.settings)
  if (target.kind === 'environment') {
    const sourceRoute = context?.worktreeId
      ? resolveWorktreeOperationRouteResult(state, context.worktreeId)
      : null
    // A paired host can proxy a separate SSH owner; keep that target's identity.
    if (
      sourceRoute?.kind === 'resolved' &&
      sourceRoute.route.runtimeEnvironmentId === target.environmentId &&
      sourceRoute.route.executionHostId
    ) {
      return sourceRoute.route.executionHostId
    }
    return toRuntimeExecutionHostId(target.environmentId)
  }
  return context?.connectionId ? toSshExecutionHostId(context.connectionId) : 'local'
}

export function resolveKnownWorktreeRootPathLink(
  path: string,
  state: WorktreeRootPathState = useAppStore.getState(),
  fileContext?: RuntimeFileOperationArgs
): WorktreeRootPathLink | null {
  const sourceHost = terminalFileSourceHost(state, fileContext)
  const pathComparisonKey = getWorktreeRootPathComparisonKey(path)
  const roots = getWorktreeRootPathIndex(state.worktreesByRepo).get(pathComparisonKey) ?? []
  let match: WorktreeRootPathLink | null = null
  for (const root of roots) {
    const exact = resolveExactWorktreeRoute(state, root)
    const owner =
      exact.kind === 'missing' ? resolveWorktreeOperationRouteResult(state, root.id) : exact
    if (owner.kind !== 'resolved') {
      continue
    }
    const hostId =
      owner.route.executionHostId ??
      (owner.route.runtimeEnvironmentId
        ? toRuntimeExecutionHostId(owner.route.runtimeEnvironmentId)
        : null)
    if (hostId !== sourceHost) {
      continue
    }
    if (match) {
      return null
    }
    match = { id: root.id, path: root.path, executionHostId: hostId }
  }
  return match
}
