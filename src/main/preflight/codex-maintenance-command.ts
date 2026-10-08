import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { codexMaintenanceAction } from '../../shared/codex-cli-maintenance'
import { resolveCliCommand, withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import type { ProcessSpec } from '../../shared/child-process/run-process'
import { resolveCodexStructuredInvocation } from '../codex/codex-structured-launch-resolution'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { listLocalCommandPaths } from '../ipc/command-path-resolver'
import { codexCliPackagePaths, readCodexCliInstallation } from './codex-cli-installation'

const Package = z.object({ name: z.literal('@openai/codex') })

export async function resolveCodexMaintenanceCommand() {
  const { command, environment } = await resolveCodexStructuredInvocation({
    resolveEnvironment: resolveLoginShellEnvironment
  })
  const program =
    (await listLocalCommandPaths(command, { env: environment, maxResults: 1 }))[0] ?? command
  const launch = { program, env: withCliRuntimeOnPath(program, environment ?? process.env) }
  const installation = await readCodexCliInstallation(launch)
  const packagePaths = await codexCliPackagePaths(launch)
  const npmInstalled = (
    await Promise.all(
      packagePaths.map(async (file) => {
        try {
          return Package.safeParse(JSON.parse(await readFile(file, 'utf8'))).success
        } catch {
          return false
        }
      })
    )
  ).some(Boolean)
  const action = codexMaintenanceAction(installation, npmInstalled)
  let spec: ProcessSpec | null = null
  if (action) {
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
      args: useNpm ? ['install', '-g', '@openai/codex'] : ['update']
    }
  }
  return { installation, action, spec }
}
