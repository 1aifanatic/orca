import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeRuntimeAuthPreparation } from '../../claude-accounts/runtime-auth/runtime-auth-types'

const applyAgentWorkspaceTrust = vi.hoisted(() =>
  vi.fn<(preset: string, path: string, context: unknown) => Promise<object>>(async () => ({}))
)
vi.mock('../../agent-workspace-trust', () => ({ applyAgentWorkspaceTrust }))

import { buildPtyIpcSpawnOptions } from './ipc/spawn-options'
import { createPtyIpcSpawnState } from './ipc/spawn-state'
import type { AdoptStablePaneResult, PtySpawnIpcDeps } from './ipc/spawn-types'
import { buildRuntimePtySpawnOptions } from './runtime/spawn-options'
import { createRuntimePtySpawnState } from './runtime/spawn-state'
import type { PtyRuntimeControllerDeps } from './runtime/controller-deps'

type BuildInput = {
  connectionId?: string
  launchAgent?: string
  command?: string
  restored?: boolean
  claudeAuth?: ClaudeRuntimeAuthPreparation | null
  wslDistro?: string | null
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builders only test this for truthiness before the trust hook runs.
const RESTORED_PANE = {} as AdoptStablePaneResult

const DEPS = { getSettings: () => ({ agentWorkspaceTrustEnabled: true }) }

function seed(
  ctx: {
    env: Record<string, string>
    launchCommand: string | undefined
    claudeAuth: ClaudeRuntimeAuthPreparation | null
    expectedWslDistro: string | null
    preAdoptedStablePane: AdoptStablePaneResult | null
  },
  input: BuildInput
): void {
  ctx.env = { CLAUDE_CONFIG_DIR: '/cfg' }
  ctx.launchCommand = input.command
  ctx.claudeAuth = input.claudeAuth ?? null
  ctx.expectedWslDistro = input.wslDistro ?? null
  ctx.preAdoptedStablePane = input.restored ? RESTORED_PANE : null
}

async function build(route: 'renderer' | 'runtime', input: BuildInput) {
  const args = {
    cols: 80,
    rows: 24,
    worktreeId: 'repo-1::/repo/wt',
    connectionId: input.connectionId,
    launchAgent: input.launchAgent,
    command: input.command
  }
  if (route === 'renderer') {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: option building reads only getSettings from deps with no hidden pane or runtime.
    const ctx = createPtyIpcSpawnState(DEPS as unknown as PtySpawnIpcDeps, args)
    seed(ctx, input)
    await buildPtyIpcSpawnOptions(ctx)
    ctx.finishTerminalInstall()
    return ctx.spawnOptions
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: option building reads only getSettings from deps with no hidden pane or runtime.
  const ctx = createRuntimePtySpawnState(DEPS as unknown as PtyRuntimeControllerDeps, args)
  seed(ctx, input)
  await buildRuntimePtySpawnOptions(ctx)
  ctx.finishTerminalInstall()
  return ctx.spawnOptions
}

beforeEach(() => {
  applyAgentWorkspaceTrust.mockReset()
  applyAgentWorkspaceTrust.mockResolvedValue({})
})

describe.each(['renderer', 'runtime'] as const)('%s spawn builder agent trust', (route) => {
  it('pre-trusts the workspace for a fresh agent launch with the final spawn context', async () => {
    await build(route, {
      launchAgent: 'codex',
      command: 'codex',
      wslDistro: 'Ubuntu'
    })
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith('codex', '/repo/wt', {
      env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/cfg' }),
      claudeAuth: null,
      wslDistro: 'Ubuntu',
      connectionId: null
    })
  })

  it('keys on the declared agent even when setup sequencing rewrote the command', async () => {
    await build(route, { launchAgent: 'claude', command: 'sh /tmp/orca-setup-runner.sh' })
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith('claude', '/repo/wt', expect.anything())
  })

  it('never re-runs trust for a restored pane or a spawn with no launch command', async () => {
    await build(route, { launchAgent: 'claude', command: 'claude', restored: true })
    await build(route, { launchAgent: 'claude' })
    expect(applyAgentWorkspaceTrust).not.toHaveBeenCalled()
  })

  it('forwards the relay trust field on an SSH Claude spawn', async () => {
    applyAgentWorkspaceTrust.mockResolvedValueOnce({
      claudeFolderTrust: { workspacePath: '/repo/wt' }
    })
    const options = await build(route, {
      connectionId: 'ssh-1',
      launchAgent: 'claude',
      command: 'claude'
    })
    expect(options.claudeFolderTrust).toEqual({ workspacePath: '/repo/wt' })
  })
})
