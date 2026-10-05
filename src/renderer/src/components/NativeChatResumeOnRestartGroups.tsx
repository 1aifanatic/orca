import { useMemo } from 'react'
import { Folder, FolderTree, GitBranch } from 'lucide-react'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import WorktreeCard from '@/components/sidebar/WorktreeCard'
import { WorktreeHostContextBadge } from '@/components/sidebar/WorktreeHostContextBadge'
import {
  getLineageChildrenInlineStyle,
  getLineageNestedRowGeometry
} from '@/components/sidebar/worktree-list/rows/indentation'
import {
  getCyclicProjectedWorktreeLineageIds,
  getSidebarLineageAncestors
} from '@/components/sidebar/worktree-lineage-projection'
import {
  getAllWorktreesFromState,
  getWorktreeMapFromState,
  getWorktreeOnHostFromState
} from '@/store/selectors'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { getHostContextLabel } from '../../../shared/worktree/host-context-labels'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { AgentSessionWorkspaceKind } from '../../../shared/agent-session-record'
import { useAppStore } from '../store'
import { ResumeCandidateRow } from './NativeChatResumeOnRestartAgentRow'
import {
  groupResumeCandidates,
  groupResumeWorkspacesByRepo,
  nestResumeWorkspaces,
  resolveResumeGroupHeader,
  resumeWorkspaceKind,
  type ResumeCandidate,
  type ResumeFailure,
  type ResumeWorkspaceGroup,
  type ResumeWorkspaceNode
} from './native-chat-resume-on-restart-grouping'
import type { ResumeFailureAction } from './native-chat-resume-failure-guidance'

export type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'

/**
 * The offered chats in the sidebar's three tiers: repo/project, then workspace, then agent sessions.
 *
 * Each workspace IS the sidebar's own `WorktreeCard`, rendered read-only, so the user recognizes it
 * exactly as they know it — title, branch, PR and host as their sidebar settings show them —
 * with the offered chats in place of its live agent rows. Child workspaces nest under a listed
 * parent the way the sidebar nests them.
 *
 * A workspace the store does not know yet (its host still connecting, or since deleted) falls back
 * to a plain header: glyph, name, host chip. The sidebar has no git-worktree vs folder glyph
 * resolver; that header follows its status lane, which picks `GitBranch` for a branch identity.
 */

/** Lets a row that an earlier resume could not carry on show what went wrong and what to do. */
type FailureProps = {
  failureFor?: (sessionId: string) => ResumeFailure | undefined
  onFailureAction?: (action: ResumeFailureAction, sessionId: string) => void
}

/** The store's row for a workspace on its own host; folder workspaces included. Stable per row. */
function useWorkspaceWorktree(workspaceId: string, hostId: ExecutionHostId | undefined) {
  return useAppStore((store) => store.getKnownWorktreeById(workspaceId, hostId))
}

/**
 * The repo owning each workspace, as one narrow subscription.
 *
 * Selected as a joined string rather than a map so the selector returns a PRIMITIVE: a fresh object
 * or array would fail the equality check on every store change and re-render the whole list.
 */
function useRepoIdByWorkspace(
  workspaces: readonly ResumeWorkspaceGroup[]
): (workspaceId: string) => string | null {
  const ids = workspaces.map((group) => group.workspaceId)
  const hosts = workspaces.map((group) => group.candidates[0]?.executionHostId)
  const joined = useAppStore((store) =>
    ids.map((id, index) => store.getKnownWorktreeById(id, hosts[index])?.repoId ?? '').join('\0')
  )
  const repoIds = joined.split('\0')
  return (workspaceId: string) => {
    const index = ids.indexOf(workspaceId)
    const repoId = index === -1 ? '' : (repoIds[index] ?? '')
    return repoId === '' ? null : repoId
  }
}

/** Each workspace's lineage ancestors, nearest first, by the sidebar's own nesting rule. */
function useLineageAncestors(
  workspaces: readonly ResumeWorkspaceGroup[]
): (workspaceId: string) => readonly string[] {
  const worktreesByRepo = useAppStore((store) => store.worktreesByRepo)
  const worktreeLineageById = useAppStore((store) => store.worktreeLineageById)
  const ancestors = useMemo(() => {
    const state = { worktreesByRepo }
    // Why: archived rows never render in the sidebar, so nothing nests under them.
    const rows = new Map(
      getAllWorktreesFromState(state)
        .filter((worktree) => !worktree.isArchived)
        .map((worktree) => [getWorktreeHostIdentity(worktree), worktree])
    )
    const cyclic = getCyclicProjectedWorktreeLineageIds(
      worktreeLineageById,
      getWorktreeMapFromState(state)
    )
    return new Map(
      workspaces.map((group) => {
        // Why: a row with no host id (older metadata) is still the chat's workspace.
        const target =
          getWorktreeOnHostFromState(
            state,
            group.workspaceId,
            group.candidates[0]?.executionHostId
          ) ?? rows.get(composeWorktreeHostIdentity(undefined, group.workspaceId))
        const parents = target
          ? getSidebarLineageAncestors(target, worktreeLineageById, rows, cyclic)
          : []
        return [group.workspaceId, parents.map((parent) => parent.id)]
      })
    )
  }, [workspaces, worktreesByRepo, worktreeLineageById])
  return (workspaceId) => ancestors.get(workspaceId) ?? []
}

/** The glyph for the workspace itself. Kind comes from the host's record, never from a name. */
function WorkspaceKindGlyph({ kind }: { kind: AgentSessionWorkspaceKind }): React.JSX.Element {
  return kind === 'folder' ? (
    <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  ) : (
    <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  )
}

/**
 * The top tier: a git repo, or the project group a folder workspace belongs to.
 *
 * A folder workspace's synthetic worktree carries `repoId` of `folder-workspace:<projectGroupId>` —
 * never null — so "no repo" cannot be detected by testing for absence. `projectGroupIdFromRepoId`
 * is the only thing that separates the two, and the sidebar likewise titles these with the project
 * group's name.
 */
function RepoHeader({ repoId }: { repoId: string | null }): React.JSX.Element {
  const repos = useAppStore((store) => store.repos)
  const projectGroups = useAppStore((store) => store.projectGroups)
  const header = resolveResumeGroupHeader(repoId, repos, projectGroups)
  return (
    <div className="flex items-center gap-1.5 px-0.5">
      {/* A repo shows its own configured glyph; a project group uses the FolderTree the sidebar's
          own PROJECT_GROUP_META uses. */}
      {header.kind === 'project' ? (
        <FolderTree className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <RepoIconGlyph repoIcon={header.repoIcon} className="size-3.5" iconClassName="size-3.5" />
      )}
      <span className="min-w-0 flex-1 truncate text-xs font-semibold">{header.name}</span>
    </div>
  )
}

type RowProps = {
  listedAt: number
  busy: boolean
  selected: ReadonlySet<string>
  onToggle: (sessionId: string, checked: boolean) => void
} & FailureProps

function WorkspaceCard({
  node,
  depth,
  ...rowProps
}: { node: ResumeWorkspaceNode; depth: number } & RowProps): React.JSX.Element {
  const { group } = node
  const first = group.candidates[0]
  const hostId = first?.executionHostId
  const worktree = useWorkspaceWorktree(group.workspaceId, hostId)
  const repo = useAppStore((store) =>
    worktree ? store.repos.find((entry) => entry.id === worktree.repoId) : undefined
  )
  const newCardStyle = useAppStore(
    (store) => store.settings?.experimentalNewWorktreeCardStyle === true
  )
  const name = worktree?.displayName ?? group.workspaceId
  // Shown for every workspace, local included. The sidebar hides it on a single-host install; this
  // list is a one-off prompt with no surrounding context, so the machine is always worth naming.
  const hostLabel = getHostContextLabel(hostId ?? LOCAL_EXECUTION_HOST_ID)
  const { listedAt, busy, selected, onToggle, failureFor, onFailureAction } = rowProps
  const rows = (
    <ul className="flex flex-col">
      {group.candidates.map((candidate) => (
        <ResumeCandidateRow
          key={candidate.sessionId}
          candidate={candidate}
          workspaceName={name}
          listedAt={listedAt}
          checked={selected.has(candidate.sessionId)}
          disabled={busy}
          onCheckedChange={(checked) => onToggle(candidate.sessionId, checked)}
          failure={failureFor?.(candidate.sessionId)}
          onFailureAction={onFailureAction}
        />
      ))}
    </ul>
  )
  const geometryAt = (lineageDepth: number) =>
    getLineageNestedRowGeometry({
      experimentalNewWorktreeCardStyle: newCardStyle,
      inheritedCardContentIndent: 0,
      lineageDepth
    })
  const geometry = geometryAt(depth)
  // Why: as in the sidebar, a child inside a card's lineage list is inset for its own depth.
  const childInset = worktree ? geometryAt(depth + 1).surfaceInset : 0
  const children = node.children.map((child) => (
    <div
      key={child.group.workspaceId}
      style={childInset > 0 ? { paddingLeft: childInset } : undefined}
    >
      <WorkspaceCard node={child} depth={depth + 1} {...rowProps} />
    </div>
  ))

  if (!worktree) {
    const kind = first ? resumeWorkspaceKind(first) : 'git-worktree'
    return (
      <section className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5 px-0.5">
          <WorkspaceKindGlyph kind={kind} />
          <span className="min-w-0 truncate text-xs font-medium">{name}</span>
          <WorktreeHostContextBadge label={hostLabel} />
        </div>
        <div className="pl-1">{rows}</div>
        {children.length > 0 && <div className="flex flex-col gap-1 pl-3">{children}</div>}
      </section>
    )
  }

  return (
    <WorktreeCard
      worktree={worktree}
      repo={repo}
      isActive={false}
      isActiveSurface={false}
      readOnly
      // The repo header above already names it.
      hideRepoBadge
      hostContextLabel={hostLabel}
      nativeDragEnabled={false}
      flushSurface
      contentIndent={geometry.cardContentIndent}
      agentRows={rows}
      lineageChildren={children.length > 0 ? children : undefined}
      lineageChildrenStyle={
        children.length > 0
          ? getLineageChildrenInlineStyle(geometry.lineageChildrenInlineOffset)
          : undefined
      }
    />
  )
}

export function ResumeOnRestartGroups({
  candidates,
  listedAt,
  busy,
  selected,
  onToggle,
  failureFor,
  onFailureAction
}: {
  candidates: readonly ResumeCandidate[]
  listedAt: number
  busy: boolean
  selected: ReadonlySet<string>
  onToggle: (sessionId: string, checked: boolean) => void
} & FailureProps): React.JSX.Element {
  const workspaces = useMemo(() => groupResumeCandidates(candidates), [candidates])
  const repoIdFor = useRepoIdByWorkspace(workspaces)
  const ancestorsOf = useLineageAncestors(workspaces)
  const repoGroups = groupResumeWorkspacesByRepo(workspaces, repoIdFor)
  return (
    <div className="flex flex-col gap-2.5">
      {repoGroups.map((repoGroup) => (
        <section key={repoGroup.repoId ?? 'no-repo'} className="flex flex-col gap-1">
          <RepoHeader repoId={repoGroup.repoId} />
          <div className="flex flex-col gap-1">
            {nestResumeWorkspaces(repoGroup.workspaces, ancestorsOf).map((node) => (
              <WorkspaceCard
                key={node.group.workspaceId}
                node={node}
                depth={0}
                listedAt={listedAt}
                busy={busy}
                selected={selected}
                onToggle={onToggle}
                failureFor={failureFor}
                onFailureAction={onFailureAction}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
