import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { resolveConfiguredWorkerAgent } from './orchestration/configured-worker-agent-selector'

it.each(['folder', 'ssh', 'wsl'] as const)(
  'resolves the %s target platform before interpreting an alias',
  async (kind) => {
    const scope = {
      path: kind === 'wsl' ? '\\\\wsl.localhost\\Ubuntu\\repo' : '/opt/repo',
      connectionId: kind === 'ssh' ? 'ssh-1' : null
    }
    const context = {
      resolveTerminalWorkspaceLaunchScope: vi.fn(async () => scope),
      getAgentLaunchPlatformForWorkspace: vi.fn(() => 'linux' as const),
      resolveOrchestrationAgentLauncher: vi.fn((selector: string, platform: NodeJS.Platform) =>
        resolveConfiguredWorkerAgent(
          selector,
          { opencode: '/opt/My\\ Agent/opencode-private' },
          platform
        )
      )
    }
    const result = await Reflect.apply(
      OrcaRuntimeService.prototype.resolveOrchestrationAgentLauncherForTarget,
      context,
      ['opencode-private', { worktree: 'id:workspace' }]
    )
    expect(result).toBe('opencode')
    expect(context.getAgentLaunchPlatformForWorkspace).toHaveBeenCalledWith(scope)
    expect(context.resolveOrchestrationAgentLauncher).toHaveBeenCalledWith(
      'opencode-private',
      'linux'
    )
  }
)

describe('canonical worker agent target', () => {
  it('keeps canonical selectors authoritative without probing another host', async () => {
    const resolve = vi.fn()
    expect(
      await Reflect.apply(
        OrcaRuntimeService.prototype.resolveOrchestrationAgentLauncherForTarget,
        { resolveTerminalWorkspaceLaunchScope: resolve },
        ['opencode', { worktree: 'id:remote' }]
      )
    ).toBe('opencode')
    expect(resolve).not.toHaveBeenCalled()
  })
})
