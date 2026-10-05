import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import {
  parseStructuredAgentCommandOverride,
  validateStructuredAgentCommandArgs,
  type StructuredAgentCommandInvocation
} from '../../shared/tui-agent-launch-command-override'
import { AgentSessionPreSpawnError } from './agent-session-wire/structured-agent-session-adapter'

export function resolveStructuredAgentCommand(input: {
  agent: 'claude' | 'codex'
  override: string | null | undefined
  env: NodeJS.ProcessEnv
  cwd?: string
  platform?: NodeJS.Platform
}): StructuredAgentCommandInvocation | null {
  const platform = input.platform ?? process.platform
  try {
    const invocation = parseStructuredAgentCommandOverride(input.override, platform)
    if (!invocation) {
      return null
    }
    const api = platform === 'win32' ? path.win32 : path.posix
    const home = input.env.HOME ?? input.env.USERPROFILE ?? homedir()
    let command = invocation.command
    if (command.startsWith('~/') || (platform === 'win32' && command.startsWith('~\\'))) {
      command = api.join(home, command.slice(2))
    }
    command =
      command.includes('/') || (platform === 'win32' && command.includes('\\'))
        ? api.resolve(input.cwd ?? home, command)
        : resolveCliCommand(command, {
            platform,
            pathEnv: Object.entries(input.env).find(([key]) =>
              platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH'
            )?.[1],
            homePath: home
          })
    if (!api.isAbsolute(command) || !statSync(command).isFile()) {
      throw new Error('program not found')
    }
    if (platform === 'win32' && !/\.(exe|com|cmd|bat)$/i.test(command)) {
      throw new Error('program not executable on Windows')
    }
    accessSync(command, platform === 'win32' ? constants.F_OK : constants.X_OK)
    const shell = api
      .basename(command)
      .replace(/\.exe$/i, '')
      .toLowerCase()
    if (['sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh', 'env'].includes(shell)) {
      throw new Error('custom command requires a shell')
    }
    const result = {
      command,
      prefixArgs: invocation.prefixArgs,
      ...(input.cwd ? { cwd: input.cwd } : {})
    }
    assertStructuredAgentCommandPreferences(input.agent, result)
    return result
  } catch (error) {
    if (error instanceof AgentSessionPreSpawnError) {
      throw error
    }
    throw new AgentSessionPreSpawnError(error, { reason: 'customCommandInvalid' })
  }
}

export function assertStructuredAgentCommandPreferences(
  agent: 'claude' | 'codex',
  invocation: StructuredAgentCommandInvocation,
  options?: Readonly<Record<string, unknown>>
): void {
  const reason = validateStructuredAgentCommandArgs(agent, invocation.prefixArgs, options)
  if (reason) {
    throw new AgentSessionPreSpawnError('custom command conflicts with structured launch', {
      reason
    })
  }
}
