import { useMemo } from 'react'
import { Folder, FolderTree, GitBranch } from 'lucide-react'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { WorktreeHostContextBadge } from '@/components/sidebar/WorktreeHostContextBadge'
import { useSidebarHostScopeOptions } from '@/components/sidebar/use-sidebar-host-scope-options'
import {
  getCyclicProjectedWorktreeLineageIds,
  getSidebarLineageAncestors
} from '@/components/sidebar/worktree-lineage-projection'
import { translate } from '@/i18n/i18n'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from '@/lib/worktree-default-display-name'
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
import { Checkbox } from './ui/checkbox'
import { ResumeCandidateRow } from './NativeChatResumeOnRestartAgentRow'
import {
  groupResumeCandidates,
  groupResumeWorkspacesByRepo,
  nestResumeWorkspaces,
  resolveResumeGroupHeader,
  resumeSelectionState,
  resumeWorkspaceKind,
  resumeWorkspaceSessionIds,
  toggleResumeSelection,
  type ResumeCandidate,
  type ResumeFailure,
  type ResumeWorkspaceGroup,
  type ResumeWorkspaceNode
} from './native-chat-resume-on-restart-grouping'
import {
  resumeFailureSelectable,
  type ResumeFailureAction
} from './native-chat-resume-failure-guidance'

export type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'

/**
 * The offered chats as a checkbox list in the sidebar's three tiers: repo/project, then workspace,
 * then agent sessions.
 *
 * A grouped list: each project and workspace heads its group with a tinted band, chats are split by
 * hairlines. Every row's checkbox sits in one column at the left edge; nesting indents only what
 * follows it. A workspace checkbox covers its own chats and those of the workspaces nested under it,
 * which follow the sidebar's own lineage rule; a project checkbox covers every chat in the project.
 *
 * A workspace the store does not know yet (its host still connecting, or since deleted) is named
 * by its id. The kind glyph comes from the host's record of the chat, never from a name.
 */

/** Indent per nesting level, applied right of the checkbox column. */
const RESUME_INDENT_PX = 20

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
function RepoHeader({
  repoId,
  covered,
  busy,
  selected,
  onToggle
}: {
  repoId: string | null
  /** Every selectable chat in the project, nested workspaces included. */
  covered: readonly string[]
  busy: boolean
  selected: ReadonlySet<string>
  onToggle: (sessionId: string, checked: boolean) => void
}): React.JSX.Element {
  const repos = useAppStore((store) => store.repos)
  const projectGroups = useAppStore((store) => store.projectGroups)
  const header = resolveResumeGroupHeader(repoId, repos, projectGroups)
  const selection = resumeSelectionState(covered, selected)
  return (
    // A band a step stronger than a workspace's, so the project reads as the outer group.
    <label className="grid h-8.5 cursor-pointer grid-cols-[1.75rem_minmax(0,1fr)] items-center border-t border-border bg-[color-mix(in_srgb,var(--foreground)_5%,var(--worktree-sidebar-accent))] hover:bg-[color-mix(in_srgb,var(--foreground)_9%,var(--worktree-sidebar-accent))] has-[:disabled]:cursor-default">
      <span className="flex justify-center">
        <Checkbox
          checked={selection.checked}
          disabled={busy || selection.total === 0}
          onCheckedChange={() => toggleResumeSelection(covered, selection, onToggle)}
          aria-label={translate(
            'auto.components.NativeChatResumeOnRestartModal.selectProject',
            'Select all chats in {{value0}}',
            { value0: header.name }
          )}
        />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pr-2.5">
        {/* A repo shows its own configured glyph; a project group uses the FolderTree the sidebar's
            own PROJECT_GROUP_META uses. */}
        {header.kind === 'project' ? (
          <FolderTree className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <RepoIconGlyph repoIcon={header.repoIcon} className="size-3.5" iconClassName="size-3.5" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{header.name}</span>
        {selection.total > 0 && (
          <span className="shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">
            {translate(
              'auto.components.NativeChatResumeOnRestartModal.workspaceSelectedCount',
              '{{value0}} of {{value1}}',
              { value0: selection.selectedCount, value1: selection.total }
            )}
          </span>
        )}
      </span>
    </label>
  )
}

type RowProps = {
  /** Whether the listed chats span machines; every workspace then names its host. */
  mixedHosts: boolean
  listedAt: number
  busy: boolean
  selected: ReadonlySet<string>
  onToggle: (sessionId: string, checked: boolean) => void
  /** Whether a group checkbox may tick this chat; a failure a retry cannot fix is left out. */
  selectable: (sessionId: string) => boolean
  /** The sidebar's host names (SSH target labels, display overrides), so a chip never shows a raw id. */
  hostLabelById: ReadonlyMap<ExecutionHostId, string>
} & FailureProps

function WorkspaceRows({
  node,
  depth,
  ...rowProps
}: { node: ResumeWorkspaceNode; depth: number } & RowProps): React.JSX.Element {
  const { group } = node
  const first = group.candidates[0]
  const hostId = first?.executionHostId
  const worktree = useWorkspaceWorktree(group.workspaceId, hostId)
  const kind = first ? resumeWorkspaceKind(first) : 'git-worktree'
  const name = (worktree && resolveWorktreeDisplayName(worktree)) || group.workspaceId
  const branch = worktree && kind === 'git-worktree' ? resolveWorktreeBranchLabel(worktree) : ''
  const { mixedHosts, listedAt, busy, selected, onToggle, selectable, hostLabelById } = rowProps
  // Why: a remote workspace is named by its machine even when it is the only one listed.
  const showHostLabel =
    mixedHosts || (hostId ?? LOCAL_EXECUTION_HOST_ID) !== LOCAL_EXECUTION_HOST_ID
  const covered = resumeWorkspaceSessionIds(node).filter(selectable)
  const selection = resumeSelectionState(covered, selected)
  const chatIndent: React.CSSProperties & Record<'--resume-chat-indent', string> = {
    '--resume-chat-indent': `${(depth + 1) * RESUME_INDENT_PX}px`
  }
  return (
    <>
      {/* The workspace's band heads its group; a nested one is lighter, at its own indent. */}
      <label
        data-nested={depth > 0}
        className="grid h-8 cursor-pointer grid-cols-[1.75rem_minmax(0,1fr)] items-center border-y border-border bg-worktree-sidebar-accent hover:bg-[color-mix(in_srgb,var(--foreground)_6%,var(--worktree-sidebar-accent))] has-[:disabled]:cursor-default data-[nested=true]:bg-worktree-sidebar-accent/50"
      >
        <span className="flex justify-center">
          <Checkbox
            checked={selection.checked}
            disabled={busy || selection.total === 0}
            onCheckedChange={() => toggleResumeSelection(covered, selection, onToggle)}
            aria-label={translate(
              'auto.components.NativeChatResumeOnRestartModal.selectWorkspace',
              'Select all chats in {{value0}}',
              { value0: name }
            )}
          />
        </span>
        <span
          className="flex min-w-0 items-center gap-1.5 pr-2.5"
          style={depth > 0 ? { paddingLeft: depth * RESUME_INDENT_PX } : undefined}
        >
          <WorkspaceKindGlyph kind={kind} />
          <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">{name}</span>
          {branch && (
            <span className="min-w-0 shrink-2 truncate text-[11px] text-muted-foreground">
              {branch}
            </span>
          )}
          {showHostLabel && (
            <WorktreeHostContextBadge
              label={getHostContextLabel(hostId ?? LOCAL_EXECUTION_HOST_ID, {
                hostLabelById
              })}
            />
          )}
          {selection.total > 0 && (
            <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">
              {translate(
                'auto.components.NativeChatResumeOnRestartModal.workspaceSelectedCount',
                '{{value0}} of {{value1}}',
                { value0: selection.selectedCount, value1: selection.total }
              )}
            </span>
          )}
        </span>
      </label>
      <ul style={chatIndent}>
        {group.candidates.map((candidate) => (
          <ResumeCandidateRow
            key={candidate.sessionId}
            candidate={candidate}
            workspaceName={name}
            listedAt={listedAt}
            checked={selected.has(candidate.sessionId)}
            disabled={busy}
            onCheckedChange={(checked) => onToggle(candidate.sessionId, checked)}
            failure={rowProps.failureFor?.(candidate.sessionId)}
            onFailureAction={rowProps.onFailureAction}
          />
        ))}
      </ul>
      {node.children.map((child) => (
        <WorkspaceRows key={child.group.workspaceId} node={child} depth={depth + 1} {...rowProps} />
      ))}
    </>
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
  const { hostOptions } = useSidebarHostScopeOptions()
  const hostLabelById = useMemo(
    () => new Map(hostOptions.map((host) => [host.id, host.label])),
    [hostOptions]
  )
  const repoGroups = groupResumeWorkspacesByRepo(workspaces, repoIdFor)
  const mixedHosts =
    new Set(candidates.map((candidate) => candidate.executionHostId ?? LOCAL_EXECUTION_HOST_ID))
      .size > 1
  const selectable = (sessionId: string): boolean => {
    const failure = failureFor?.(sessionId)
    return !failure || resumeFailureSelectable(failure)
  }
  return (
    <div className="flex flex-col">
      {repoGroups.map((repoGroup) => (
        <section key={repoGroup.repoId ?? 'no-repo'} className="flex flex-col">
          <RepoHeader
            repoId={repoGroup.repoId}
            covered={repoGroup.workspaces
              .flatMap((group) => group.candidates.map((candidate) => candidate.sessionId))
              .filter(selectable)}
            busy={busy}
            selected={selected}
            onToggle={onToggle}
          />
          {nestResumeWorkspaces(repoGroup.workspaces, ancestorsOf).map((node) => (
            <WorkspaceRows
              key={node.group.workspaceId}
              node={node}
              depth={0}
              mixedHosts={mixedHosts}
              listedAt={listedAt}
              busy={busy}
              selected={selected}
              onToggle={onToggle}
              selectable={selectable}
              hostLabelById={hostLabelById}
              failureFor={failureFor}
              onFailureAction={onFailureAction}
            />
          ))}
        </section>
      ))}
    </div>
  )
}
