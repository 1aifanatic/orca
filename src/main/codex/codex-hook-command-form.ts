import { quotePowerShellLiteral } from '../../shared/powershell-native-argument'

/**
 * The Codex hook command every Orca build writes, frozen per form.
 *
 * Why frozen: ~/.codex is shared by every Orca instance and build on this
 * HOME. Bytes that depend on the build make two builds rewrite each other's
 * entry, with a Codex trust session each time. A form changes only with a
 * bump here, and a build never rewrites an entry of a higher form.
 */
export const CODEX_HOOK_COMMAND_FORM = 1

const FORM_MARKER = /orca-agent-hook-form=(\d+)/

// Why literals, not the shared hook constants: a change there must not move these bytes.
const POSIX_STDIN_DRAIN = '{ command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :'
const POWERSHELL_ORCA_ENV_GUARD =
  'if (-not $env:ORCA_AGENT_HOOK_PORT -or -not $env:ORCA_AGENT_HOOK_TOKEN -or -not $env:ORCA_PANE_KEY) { exit 0 }'

// Why a bare path: it runs under every Windows host Codex uses: PowerShell 7 or
// 5.1 from the turn's shell, else %COMSPEC% /C. It cannot carry a marker, so
// later forms change the script, never this path.
const WINDOWS_BARE_PATH = /^[A-Za-z0-9_.:/~-]+$/

function buildPosixCommand(): string {
  const rootScript = '"${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh"'
  const sharedScript = '"${HOME-}/.orca/agent-hooks/codex-hook.sh"'
  // Why the root branch: dormant until Orca sets ORCA_AGENT_HOOK_ROOT, so the
  // bytes need not change when it does. The shared branch needs a hook port,
  // so a pane with hooks off and every shell outside Orca only drain stdin.
  return [
    `: orca-agent-hook-form=${CODEX_HOOK_COMMAND_FORM};`,
    `if [ -n "\${ORCA_PANE_KEY-}" ] && [ -n "\${ORCA_AGENT_HOOK_ROOT-}" ] && [ -f ${rootScript} ]; then /bin/sh ${rootScript} || :;`,
    `elif [ -z "\${ORCA_AGENT_HOOK_ROOT-}" ] && [ -n "\${ORCA_PANE_KEY-}" ] && [ -n "\${ORCA_AGENT_HOOK_PORT-}" ] && [ -f ${sharedScript} ]; then /bin/sh ${sharedScript} || :;`,
    `else ${POSIX_STDIN_DRAIN}; fi`
  ].join(' ')
}

function buildWindowsCommand(scriptPath: string): string {
  const forwardSlashPath = scriptPath.replaceAll('\\', '/')
  if (WINDOWS_BARE_PATH.test(forwardSlashPath)) {
    return forwardSlashPath
  }
  // Why: a profile path with a space or quote is not one PowerShell token.
  // PowerShell only: under Codex's %COMSPEC% /C fallback this form fails.
  const quoted = quotePowerShellLiteral(forwardSlashPath)
  const rootScript = "(Join-Path $env:ORCA_AGENT_HOOK_ROOT 'agent-hooks\\codex-hook.cmd')"
  return [
    `<# orca-agent-hook-form=${CODEX_HOOK_COMMAND_FORM} #>`,
    `if ($env:ORCA_PANE_KEY -and $env:ORCA_AGENT_HOOK_ROOT -and (Test-Path -LiteralPath ${rootScript} -PathType Leaf)) { & ${rootScript} }`,
    `elseif (-not $env:ORCA_AGENT_HOOK_ROOT -and $env:ORCA_PANE_KEY -and $env:ORCA_AGENT_HOOK_PORT -and (Test-Path -LiteralPath ${quoted} -PathType Leaf)) { & ${quoted} }`,
    `else { ${POWERSHELL_ORCA_ENV_GUARD}; [Console]::In.ReadToEnd() | Out-Null }; exit 0`
  ].join(' ')
}

/** `scriptPath` is the shared script at `~/.orca/agent-hooks`; only Windows forms embed it. */
export function buildCodexHookCommand(
  scriptPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === 'win32' ? buildWindowsCommand(scriptPath) : buildPosixCommand()
}

/**
 * The form of an Orca-shaped Codex hook command. 0 is any form from before the
 * frozen command, including every retired one.
 */
export function readCodexHookCommandForm(command: string, currentCommand: string): number {
  if (command === currentCommand) {
    return CODEX_HOOK_COMMAND_FORM
  }
  const marker = FORM_MARKER.exec(command)
  return marker ? Number(marker[1]) : 0
}
