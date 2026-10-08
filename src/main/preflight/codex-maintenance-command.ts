import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
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
import { listLocalCommandPaths } from '../ipc/command-path-resolver'
import { codexCliPackagePaths, readCodexCliInstallationEvidence } from './codex-cli-installation'

const Package = z.object({ name: z.literal('@openai/codex') })

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
  const settings = context.commandSettings ?? {}
  const sources = configuredCodexInvocationSources(() => settings)
  const environment = createStructuredAgentEnvironmentResolvers(sources)
  const invocation = await resolveCodexStructuredInvocation({
    resolveCommand: sources.resolveCommand,
    resolveEnvironment: environment.resolveCodexEnvironment
  })
  return resolveMaintenanceInvocation(invocation, context.cwd, settings)
}

async function resolveMaintenanceInvocation(
  { command, environment }: Awaited<ReturnType<typeof resolveCodexStructuredInvocation>>,
  cwd: string | undefined,
  settings: CodexCommandSettings
): Promise<ResolvedCodexMaintenanceCommand> {
  const program =
    (await listLocalCommandPaths(command, { env: environment, cwd, maxResults: 1 }))[0] ?? command
  const launch = {
    program,
    cwd,
    env: environment
  }
  const { installation, ...evidence } = await readCodexCliInstallationEvidence(launch)
  const packagePaths = await codexCliPackagePaths(launch)
  const npmPackages = (
    await Promise.all(
      packagePaths.map(async (file) => {
        try {
          return Package.safeParse(JSON.parse(await readFile(file, 'utf8'))).success ? file : null
        } catch {
          return null
        }
      })
    )
  ).filter((file): file is string => file !== null)
  const npmInstalled = npmPackages.length > 0
  const moduleDirectory = npmPackages
    .map((file) => dirname(dirname(dirname(file))))
    .find((directory) => basename(directory) === 'node_modules')
  const prefixDirectory = moduleDirectory ? dirname(moduleDirectory) : null
  const npmPrefix =
    prefixDirectory && basename(prefixDirectory) === 'lib' && process.platform !== 'win32'
      ? dirname(prefixDirectory)
      : prefixDirectory
  let action = codexMaintenanceAction(installation, npmInstalled)
  if (
    action &&
    action.command !== 'codex update' &&
    ((installation.status === 'missing' && hasExplicitTuiLaunchCommand(settings, 'codex')) ||
      (installation.status === 'unsupported' && (!npmInstalled || !npmPrefix)))
  ) {
    action = codexMaintenanceManualAction(
      program,
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
