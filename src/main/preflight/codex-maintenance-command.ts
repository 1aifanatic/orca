import { dirname, join } from 'node:path'
import { createStructuredAgentEnvironmentResolvers } from '../runtime/structured-agent-shell-environment'
import {
  configuredCodexInvocationSources,
  type CodexCommandSettings
} from '../codex/configured-codex-invocation'
import { hasExplicitTuiLaunchCommand } from '../../shared/tui-agent-launch-command-override'
import {
  codexMaintenanceAction,
  codexMaintenanceManualAction
} from '../../shared/codex-cli-maintenance'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import type { ProcessSpec } from '../../shared/child-process/run-process'
import { resolveCodexStructuredInvocation } from '../codex/codex-structured-launch-resolution'
import { listLocalCommandPaths, resolveLocalExecutionCommand } from '../ipc/command-path-resolver'
import { codexCliPackagePaths, readCodexCliInstallationEvidence } from './codex-cli-installation'
import { readCodexNpmInstallationLayout } from './codex-npm-installation-layout'

export type CodexMaintenanceContext = { cwd?: string; commandSettings?: CodexCommandSettings }
export type ResolvedCodexMaintenanceCommand = {
  installation: Awaited<ReturnType<typeof readCodexCliInstallationEvidence>>['installation']
  evidence?: { expiresAt: number; configurationId: string; observedAt?: number }
  action: ReturnType<typeof codexMaintenanceAction>
  spec: ProcessSpec | null
  recheck?: () => Promise<ResolvedCodexMaintenanceCommand>
}

export async function resolveCodexMaintenanceCommand(
  context: CodexMaintenanceContext = {}
): Promise<ResolvedCodexMaintenanceCommand> {
  const cwd = context.cwd ?? process.cwd()
  const settings = context.commandSettings ?? {}
  const sources = configuredCodexInvocationSources(() => settings)
  const environment = createStructuredAgentEnvironmentResolvers(sources)
  const invocation = await resolveCodexStructuredInvocation({
    resolveCommand: sources.resolveCommand,
    resolveEnvironment: environment.resolveCodexEnvironment
  })
  return resolveMaintenanceInvocation(invocation, cwd, settings)
}

async function resolveMaintenanceInvocation(
  { command, environment }: Awaited<ReturnType<typeof resolveCodexStructuredInvocation>>,
  cwd: string,
  settings: CodexCommandSettings
): Promise<ResolvedCodexMaintenanceCommand> {
  const selected = await resolveLocalExecutionCommand(command, { env: environment, cwd })
  const program = selected.status === 'resolved' ? selected.program : command
  const launch = {
    program,
    cwd,
    env: environment
  }
  const { installation, ...evidence } = await readCodexCliInstallationEvidence(launch)
  const packagePaths = selected.status === 'resolved' ? await codexCliPackagePaths(launch) : []
  const npmLayout = await readCodexNpmInstallationLayout(packagePaths, program)
  const npmInstalled = npmLayout !== null
  const npmPrefix = npmLayout?.kind === 'global' ? npmLayout.prefix : null
  let action = codexMaintenanceAction(installation, npmInstalled)
  if (
    action &&
    action.command !== 'codex update' &&
    ((installation.status === 'missing' && hasExplicitTuiLaunchCommand(settings, 'codex')) ||
      (installation.status === 'unsupported' && (!npmInstalled || !npmPrefix)))
  ) {
    action = codexMaintenanceManualAction(
      npmLayout?.packageRoot ?? program,
      installation.minimumVersion,
      installation.status === 'missing' ? 'install' : 'update'
    )
  }
  let spec: ProcessSpec | null = null
  if (action && !action.manual) {
    const useNpm = action.command !== 'codex update'
    let maintenanceProgram = program
    if (useNpm) {
      const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      const npmSibling = join(dirname(program), npmName)
      const npm =
        (await listLocalCommandPaths(npmSibling, { env: launch.env, maxResults: 1 }))[0] ??
        resolveCliCommand('npm', { pathEnv: launch.env.PATH ?? launch.env.Path })
      maintenanceProgram =
        (await listLocalCommandPaths(npm, { env: launch.env, maxResults: 1 }))[0] ?? npm
    }
    spec = {
      ...launch,
      program: maintenanceProgram,
      args: useNpm
        ? ['install', '-g', '@openai/codex', ...(npmPrefix ? ['--prefix', npmPrefix] : [])]
        : ['update']
    }
  }
  return {
    installation,
    evidence: { ...evidence, observedAt: Date.now() },
    action,
    spec,
    recheck: () =>
      resolveMaintenanceInvocation({ command: program, environment: launch.env }, cwd, settings)
  }
}
