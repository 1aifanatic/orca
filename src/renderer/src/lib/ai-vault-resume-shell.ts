import type { AppState } from '@/store/types'
import {
  getLocalProjectExecutionRuntimeContext,
  getLocalRepoProjectExecutionRuntimeContext
} from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { resolveLocalWindowsTerminalShellOverrideForTab } from '../../../shared/local-windows-terminal-runtime'
import { resolveWindowsShellStartupFamily } from '../../../shared/windows-terminal-shell'
import {
  resolveStartupShell,
  type AgentStartupShell
} from '../../../shared/tui-agent-startup-shell'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { parseWslUncPath } from '../../../shared/wsl-paths'

type AiVaultResumeShellState = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'folderWorkspaces'
  | 'projects'
  | 'repos'
  | 'settings'
  | 'worktreesByRepo'
>

export function resolveAiVaultResumeStartupShell(args: {
  state: AiVaultResumeShellState
  worktreeId?: string | null
  platform: NodeJS.Platform
  isLocalSession: boolean
}): AgentStartupShell {
  // Why no login-shell probe: everything this command is built from — quoting
  // and env clearing — is emitted in a form that is correct in sh and fish
  // alike, so the Unix branch never has to know which one reads the line.
  if (args.platform !== 'win32') {
    return 'posix'
  }
  const projectRuntime = args.isLocalSession
    ? getLocalProjectExecutionRuntimeContext(args.state, args.worktreeId, CLIENT_PLATFORM)
    : undefined
  const workspacePath = getAiVaultResumeWorkspacePath(
    args.state,
    args.worktreeId ?? args.state.activeWorktreeId
  )
  const shellOverride = args.isLocalSession
    ? resolveLocalWindowsTerminalShellOverrideForTab({
        explicitShellOverride: undefined,
        defaultWindowsShell: args.state.settings?.terminalWindowsShell,
        isWslWorktree: Boolean(workspacePath && parseWslUncPath(workspacePath)),
        projectRuntime
      })
    : undefined
  const shell = shellOverride ? resolveWindowsShellStartupFamily(shellOverride) : undefined
  return resolveStartupShell(args.platform, shell)
}

export function getAiVaultResumeWorkspacePath(
  state: Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>,
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return (
      state.folderWorkspaces.find((workspace) => workspace.id === workspaceScope.folderWorkspaceId)
        ?.folderPath ?? null
    )
  }
  const targetWorktreeId =
    workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : worktreeId
  return (
    Object.values(state.worktreesByRepo ?? {})
      .flat()
      .find((candidate) => candidate.id === targetWorktreeId)?.path ?? null
  )
}

export function getAiVaultResumeWorkspaceWslDistro(
  state: Pick<AppState, 'folderWorkspaces' | 'repos' | 'worktreesByRepo'> &
    Partial<Pick<AppState, 'activeRepoId' | 'activeWorktreeId' | 'projects' | 'settings'>>,
  workspaceId: string | null | undefined
): string | null {
  const workspacePath = getAiVaultResumeWorkspacePath(state, workspaceId)
  const workspaceKey = workspaceId ? parseWorkspaceKey(workspaceId) : null
  const runtimeState = {
    activeRepoId: state.activeRepoId ?? null,
    activeWorktreeId: state.activeWorktreeId ?? null,
    projects: state.projects ?? [],
    settings: state.settings ?? null,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo
  }
  // Folder launch routes resolve the project through the repo, including non-git folders.
  const runtime =
    workspaceKey?.type === 'folder'
      ? getLocalRepoProjectExecutionRuntimeContext(
          runtimeState,
          runtimeState.activeRepoId,
          CLIENT_PLATFORM
        )
      : getLocalProjectExecutionRuntimeContext(
          runtimeState,
          workspaceKey?.type === 'worktree' ? workspaceKey.worktreeId : workspaceId,
          CLIENT_PLATFORM
        )
  if (runtime?.status === 'repair-required') {
    return null
  }
  if (runtime?.status === 'resolved') {
    return runtime.runtime.kind === 'wsl' ? runtime.runtime.distro : null
  }
  return workspacePath ? (parseWslUncPath(workspacePath)?.distro ?? null) : null
}
