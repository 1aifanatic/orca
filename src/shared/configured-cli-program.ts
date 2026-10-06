import { homedir } from 'node:os'
import path from 'node:path'
import {
  WINDOWS_SPAWNABLE_EXTENSION,
  findCliExecutable,
  getExecutableNames,
  isRunnableCommand,
  type ResolveCommandOptions
} from './node-cli-command-resolution'

export function expandHomePathToken(
  token: string,
  platform: NodeJS.Platform,
  homeDir: string
): string {
  if (token === '~') {
    return homeDir
  }
  if (token.startsWith('~/') || (platform === 'win32' && token.startsWith('~\\'))) {
    return (platform === 'win32' ? path.win32 : path.posix).join(homeDir, token.slice(2))
  }
  return token
}

function withoutSurroundingQuotes(value: string): string {
  const quote = value[0]
  return value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)
    ? value.slice(1, -1)
    : value
}

/**
 * The program a user configured (a path or a name) as an absolute runnable path, found the way the
 * stock CLI is. Null when nothing runnable matches; never the bare name, so a caller cannot spawn
 * something the user did not pick.
 */
export function resolveConfiguredCliProgram(
  configured: string,
  options: ResolveCommandOptions = {}
): string | null {
  const platform = options.platform ?? process.platform
  // Why one quote pair: the same setting is typed into a shell for terminal launches, where a path
  // with spaces needs them.
  const program = expandHomePathToken(
    withoutSurroundingQuotes(configured.trim()),
    platform,
    options.homePath ?? homedir()
  )
  if (!program) {
    return null
  }
  // Why: Windows cannot start an extensionless file, and the spawn would fail with no useful error.
  const names = getExecutableNames(platform, program).filter(
    (name) => platform !== 'win32' || WINDOWS_SPAWNABLE_EXTENSION.test(name)
  )
  if (!program.includes('/') && !(platform === 'win32' && program.includes('\\'))) {
    return findCliExecutable(names, { ...options, platform })
  }
  // A relative path has no one base directory a launch could honestly resolve it against.
  if (!(platform === 'win32' ? path.win32 : path.posix).isAbsolute(program)) {
    return null
  }
  return names.find((name) => isRunnableCommand(platform, name)) ?? null
}
