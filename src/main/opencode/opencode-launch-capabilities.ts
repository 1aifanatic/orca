import {
  getFirstCommandToken,
  getCommandTokenPathBasename
} from '../../shared/command-token-scanner'
import {
  getOpenCodeCliCapabilities,
  type OpenCodeCliCapabilities
} from '../../shared/opencode-cli-version'
import type { TuiAgent } from '../../shared/tui-agent'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { runWslProcess } from '../wsl/wsl-runner'
import { probeOpenCodeCliVersion } from './opencode-cli-version'

export function getOpenCodeLaunchExecutable(
  command: string | undefined,
  agent?: TuiAgent
): string | null {
  const executable = getFirstCommandToken(command ?? '')
  const name = getCommandTokenPathBasename(executable)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|sh)$/, '')
  return agent === 'opencode' ||
    agent === 'opencode2' ||
    (!agent && (name === 'opencode' || name === 'opencode2'))
    ? executable || null
    : null
}

export async function probeOpenCodeLaunchCapabilities(options: {
  command: string | undefined
  agent?: TuiAgent
  env: NodeJS.ProcessEnv
  cwd?: string
  wsl?: { distro?: string }
  hostIdentity?: string
  resolveExecutable?: (executable: string) => Promise<string | null>
}): Promise<OpenCodeCliCapabilities | null> {
  const executable = getOpenCodeLaunchExecutable(options.command, options.agent)
  if (!executable) {
    return null
  }
  if (options.wsl) {
    const guestEnv: Record<string, string> = {}
    for (const key of [
      'OPENCODE_CONFIG_DIR',
      'ORCA_OPENCODE_CONFIG_DIR',
      'OPENCODE_DISABLE_AUTOUPDATE'
    ]) {
      const value = options.env[key]
      if (value !== undefined) {
        guestEnv[key] = value
      }
    }
    const distro = options.wsl.distro
    return probeOpenCodeCliVersion({
      executablePath: executable,
      env: guestEnv,
      hostIdentity: `${options.hostIdentity ?? 'local'}:wsl:${distro ?? 'default'}`,
      execute: () =>
        runWslProcess({
          distro,
          loginPath: 'preferred',
          program: executable,
          args: ['--version'],
          env: guestEnv,
          timeoutMs: 5_000,
          maxOutputBytes: 4_096
        })
    })
  }
  const executablePath = options.resolveExecutable
    ? await options.resolveExecutable(executable)
    : await resolveCommandOnLocalPath(executable, { env: options.env, cwd: options.cwd })
  return executablePath
    ? probeOpenCodeCliVersion({
        executablePath,
        env: options.env,
        cwd: options.cwd,
        hostIdentity: options.hostIdentity
      })
    : getOpenCodeCliCapabilities(null)
}
