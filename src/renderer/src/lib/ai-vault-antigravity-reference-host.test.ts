import { describe, expect, it, vi } from 'vitest'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { resolveAiVaultSessionLaunchTarget } from '@/components/right-sidebar/ai-vault-session-launch-target'
import {
  buildAiVaultResumeCopyCommandForWorktree,
  buildAiVaultResumeStartupForWorktree
} from './ai-vault-resume-command'
import { canResumeAiVaultSessionOnTarget } from './ai-vault-resume-target'
import { getAiVaultResumeWorkspaceWslDistro } from './ai-vault-resume-shell'
import { buildAgentLaunchRouteInput } from './agent-launch-route-input'
import type { ExecutionHostId } from '../../../shared/execution-host'

vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'win32' }))
vi.mock('@/lib/renderer-app-platform', () => ({ getRendererAppPlatform: () => 'win32' }))

type State = Parameters<typeof buildAiVaultResumeStartupForWorktree>[0]['state']
const windowsFile = 'C:/Users/example/.gemini/antigravity-ide/brain/copied-id/transcript_full.jsonl'
const linuxFile = '/home/example/.gemini/antigravity-ide/brain/copied-id/transcript_full.jsonl'
const debianFile =
  '//wsl.localhost/Debian/home/example/.gemini/antigravity-ide/brain/copied-id/transcript_full.jsonl'

function stateFor(host: ExecutionHostId, distro?: string): State {
  const worktree = makeWorktree({
    id: 'repo::workspace',
    repoId: 'repo',
    hostId: host,
    path: distro ? `//wsl.localhost/${distro}/home/example/project` : 'C:/project'
  })
  return {
    activeRepoId: 'repo',
    activeWorktreeId: worktree.id,
    folderWorkspaces: [],
    projectGroups: [],
    settings: null,
    repos: [
      {
        id: 'repo',
        path: worktree.path,
        displayName: 'project',
        badgeColor: '',
        addedAt: 0,
        executionHostId: host
      }
    ],
    projects: [
      {
        id: 'repo',
        displayName: 'project',
        badgeColor: '',
        sourceRepoIds: ['repo'],
        createdAt: 0,
        updatedAt: 0,
        localWindowsRuntimePreference: distro ? { kind: 'wsl', distro } : { kind: 'windows-host' }
      }
    ],
    worktreesByRepo: { repo: [worktree] }
  }
}

const cases = [
  { source: 'local', target: 'local', file: debianFile, distro: 'Debian', allowed: true },
  { source: 'local', target: 'local', file: debianFile, distro: 'Ubuntu', allowed: false },
  { source: 'local', target: 'local', file: debianFile, allowed: false },
  { source: 'local', target: 'local', file: windowsFile, distro: 'Debian', allowed: false },
  { source: 'local', target: 'local', file: windowsFile, allowed: true },
  { source: 'local', target: 'ssh:other', file: debianFile, allowed: false },
  { source: 'ssh:owner', target: 'ssh:other', file: linuxFile, allowed: false },
  { source: 'ssh:owner', target: 'local', file: linuxFile, allowed: false },
  { source: 'ssh:owner', target: 'ssh:owner', file: linuxFile, allowed: true },
  { source: 'runtime:owner', target: 'runtime:other', file: linuxFile, allowed: false },
  { source: 'runtime:owner', target: 'runtime:owner', file: linuxFile, allowed: true }
] as const

describe('Antigravity transcript reference ownership', () => {
  it.each(cases)(
    'confines $file from $source to $target ($distro)',
    ({ source, target, file, allowed, ...options }) => {
      const distro = 'distro' in options ? options.distro : undefined
      const state = stateFor(target, distro)
      const session = {
        agent: 'antigravity' as const,
        sessionId: 'copied-id',
        cwd: null,
        codexHome: null,
        executionHostId: source,
        executionHostPlatform: target === 'local' ? ('win32' as const) : ('linux' as const),
        filePath: file
      }
      const launch = resolveAiVaultSessionLaunchTarget({
        sessionFilePath: file,
        sessionExecutionHostId: source,
        activeWorktreeId: state.activeWorktreeId,
        targetState: state
      })
      expect(launch.status).toBe(allowed ? 'ready' : 'unsupported')
      for (const build of [
        buildAiVaultResumeStartupForWorktree,
        buildAiVaultResumeCopyCommandForWorktree
      ]) {
        if (!allowed) {
          expect(() => build({ state, session })).toThrow('execution host or WSL distro')
        } else {
          const result = build({ state, session })
          const command = typeof result === 'string' ? result : result.command
          expect(command).toContain('--prompt-interactive')
          expect(command).not.toContain('--conversation')
          expect(command).not.toContain('wsl.localhost')
        }
      }
    }
  )

  it('preserves legacy WSL ID resume eligibility on SSH', () => {
    expect(
      canResumeAiVaultSessionOnTarget({
        sessionFilePath: debianFile.replace('antigravity-ide', 'antigravity-cli'),
        sessionExecutionHostId: 'local',
        targetStatus: 'ssh',
        targetExecutionHostId: 'ssh:other'
      })
    ).toBe(true)
  })

  it('uses a project runtime override before the workspace UNC distro', () => {
    const state = stateFor('local', 'Ubuntu')
    const workspace = state.worktreesByRepo.repo?.[0]
    if (!workspace) {
      throw new Error('Missing fixture workspace')
    }
    workspace.path = '//wsl.localhost/Debian/home/example/project'
    expect(getAiVaultResumeWorkspaceWslDistro(state, workspace.id)).toBe('Ubuntu')
    expect(getAiVaultResumeWorkspaceWslDistro(state, `worktree:${workspace.id}`)).toBe('Ubuntu')
  })

  it('applies the same confinement to folder workspaces', () => {
    const state = stateFor('local')
    state.activeRepoId = null
    state.activeWorktreeId = 'folder:folder-1'
    state.folderWorkspaces = [
      makeFolderWorkspace({ folderPath: '//wsl.localhost/Debian/home/example/project' })
    ]
    expect(
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath: debianFile,
        sessionExecutionHostId: 'local',
        activeWorktreeId: 'folder:folder-1',
        targetState: state
      }).status
    ).toBe('ready')
    state.folderWorkspaces[0].folderPath = '//wsl.localhost/Ubuntu/home/example/project'
    expect(
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath: debianFile,
        sessionExecutionHostId: 'local',
        activeWorktreeId: 'folder:folder-1',
        targetState: state
      }).status
    ).toBe('unsupported')
  })

  it('uses the folder launch project runtime for a native folder path', () => {
    const state = stateFor('local', 'Debian')
    state.activeWorktreeId = 'folder:folder-1'
    state.folderWorkspaces = [makeFolderWorkspace({ folderPath: 'C:/project/folder' })]
    expect(
      buildAgentLaunchRouteInput(state, {
        agent: 'antigravity',
        workspace: { kind: 'folder', repoId: 'repo' }
      }).projectRuntime
    ).toMatchObject({ status: 'resolved', runtime: { kind: 'wsl', distro: 'Debian' } })
    expect(getAiVaultResumeWorkspaceWslDistro(state, state.activeWorktreeId)).toBe('Debian')
    for (const [file, status] of [
      [windowsFile, 'unsupported'],
      [debianFile, 'ready']
    ] as const) {
      expect(
        resolveAiVaultSessionLaunchTarget({
          sessionFilePath: file,
          sessionExecutionHostId: 'local',
          activeWorktreeId: state.activeWorktreeId,
          targetState: state
        }).status
      ).toBe(status)
    }
  })

  it('lets an explicit folder project runtime override the UNC path distro', () => {
    const state = stateFor('local', 'Ubuntu')
    state.activeWorktreeId = 'folder:folder-1'
    state.folderWorkspaces = [
      makeFolderWorkspace({
        folderPath: '//wsl.localhost/Debian/home/example/project'
      })
    ]
    expect(getAiVaultResumeWorkspaceWslDistro(state, state.activeWorktreeId)).toBe('Ubuntu')
    expect(
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath: debianFile,
        sessionExecutionHostId: 'local',
        activeWorktreeId: state.activeWorktreeId,
        targetState: state
      }).status
    ).toBe('unsupported')
  })

  it('does not substitute a local project runtime into an SSH folder launch', () => {
    const state = stateFor('ssh:owner', 'Debian')
    state.activeWorktreeId = 'folder:folder-1'
    state.folderWorkspaces = [
      makeFolderWorkspace({
        folderPath: '/remote/non-git-folder',
        executionHostId: 'ssh:owner'
      })
    ]
    expect(getAiVaultResumeWorkspaceWslDistro(state, state.activeWorktreeId)).toBeNull()
    expect(
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath: linuxFile,
        sessionExecutionHostId: 'ssh:owner',
        activeWorktreeId: state.activeWorktreeId,
        targetState: state
      }).status
    ).toBe('ready')
  })

  it('keeps references refused for SSH aliases claiming local WSL ownership', () => {
    for (const target of [
      'ssh:localhost',
      'ssh:127.0.0.1',
      'ssh:Debian',
      'ssh:local-wsl'
    ] as const) {
      expect(
        canResumeAiVaultSessionOnTarget({
          sessionFilePath: debianFile,
          sessionExecutionHostId: 'local',
          targetStatus: 'ssh',
          targetExecutionHostId: target,
          targetWslDistro: 'Debian'
        })
      ).toBe(false)
    }
  })
})
