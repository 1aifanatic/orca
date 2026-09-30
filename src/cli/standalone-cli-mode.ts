import { RuntimeClientError } from './runtime/types'

// Why: these commands own the local app, its profile store, or this machine's
// agent configs, so a client-only CLI must not run them against a paired server.
export const DESKTOP_ONLY_COMMAND_PREFIXES: readonly (readonly string[])[] = [
  ['open'],
  ['serve'],
  ['claude-teams'],
  ['account'],
  ['artifacts'],
  ['agent', 'hooks'],
  ['profile', 'state']
]

// Why: the standalone bundle defines this exact expression as "1" at build time, so
// orca.cjs under plain `node` is client-only even without the bin/orca launcher.
export function isStandaloneCli(): boolean {
  return process.env.ORCA_CLI_STANDALONE === '1'
}

export function isDesktopOnlyCommand(commandPath: readonly string[]): boolean {
  return DESKTOP_ONLY_COMMAND_PREFIXES.some((prefix) =>
    prefix.every((segment, index) => commandPath[index] === segment)
  )
}

export function desktopOnlyCommandError(commandPath: readonly string[]): RuntimeClientError {
  const command = commandPath.join(' ')
  return new RuntimeClientError(
    'desktop_only_command',
    `\`orca ${command}\` is not available in the standalone Orca CLI. Run it with the CLI installed by the Orca desktop app or headless server package (orca-ide on Linux). The standalone CLI reaches a running Orca runtime with --environment or --pairing-code.`
  )
}

export function refuseDesktopOnlyCommandInStandalone(commandPath: readonly string[]): void {
  if (isStandaloneCli() && isDesktopOnlyCommand(commandPath)) {
    throw desktopOnlyCommandError(commandPath)
  }
}
