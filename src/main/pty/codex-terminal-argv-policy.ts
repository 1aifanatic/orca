import {
  CODEX_NO_DAEMON_CONFLICTING_OPTIONS,
  CODEX_NONINTERACTIVE_COMMANDS,
  CODEX_TERMINAL_SWITCH_OPTIONS,
  CODEX_TERMINAL_VALUE_OPTIONS
} from '../../shared/codex-terminal-launch-policy'

export function posixCodexInteractiveArgv(): string {
  return `__orca_codex_interactive() {
  local __orca_arg
  for __orca_arg in "$@"; do
    case "$__orca_arg" in ${CODEX_NO_DAEMON_CONFLICTING_OPTIONS.flatMap((flag) => [flag, `${flag}=*`]).join('|')}) return 1 ;; esac
  done
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --) return 0 ;;
      --no-daemon|--help|-h|--version|-V) return 1 ;;
      ${CODEX_TERMINAL_VALUE_OPTIONS.join('|')}) [ "$#" -gt 1 ] || return 1; shift 2 ;;
      ${CODEX_TERMINAL_VALUE_OPTIONS.map((flag) => `${flag}=*`).join('|')}) shift ;;
      ${CODEX_TERMINAL_SWITCH_OPTIONS.join('|')}) shift ;;
      -*) return 1 ;;
      ${CODEX_NONINTERACTIVE_COMMANDS.join('|')}) return 1 ;;
      *) return 0 ;;
    esac
  done
  return 0
}`
}

export function powerShellCodexInteractiveArgv(): string {
  const array = (values: readonly string[]): string =>
    values.map((value) => `'${value}'`).join(', ')
  return `function Global:__OrcaCodexInteractive {
    param([string[]]$Tokens)
    foreach ($token in $Tokens) {
        if ($token.Split('=')[0] -in @(${array(CODEX_NO_DAEMON_CONFLICTING_OPTIONS)})) { return $false }
    }
    $values = @(${array(CODEX_TERMINAL_VALUE_OPTIONS)})
    $switches = @(${array(CODEX_TERMINAL_SWITCH_OPTIONS)})
    $commands = @(${array(CODEX_NONINTERACTIVE_COMMANDS)})
    for ($i = 0; $i -lt $Tokens.Count; $i++) {
        $token = $Tokens[$i]
        if ($token -eq '--') { return $true }
        if ($token -in @('--no-daemon', '--help', '-h', '--version', '-V')) { return $false }
        if ($token -in $values) { $i++; if ($i -ge $Tokens.Count) { return $false }; continue }
        if ($token -in $switches) { continue }
        if ($token.Contains('=') -and $token.Split('=')[0] -in $values) { continue }
        if ($token.StartsWith('-') -or $token -in $commands) { return $false }
        return $true
    }
    return $true
}`
}

export function fishCodexInteractiveArgv(): string {
  return `function __orca_codex_interactive
  for arg in $argv
    switch $arg
      case ${CODEX_NO_DAEMON_CONFLICTING_OPTIONS.flatMap((flag) => [flag, `'${flag}=*'`]).join(' ')}
        return 1
    end
  end
  while test (count $argv) -gt 0
    switch $argv[1]
      case --
        return 0
      case --no-daemon --help -h --version -V
        return 1
      case ${CODEX_TERMINAL_VALUE_OPTIONS.join(' ')}
        test (count $argv) -gt 1; or return 1
        set -e argv[1..2]
      case ${CODEX_TERMINAL_VALUE_OPTIONS.map((flag) => `'${flag}=*'`).join(' ')} ${CODEX_TERMINAL_SWITCH_OPTIONS.join(' ')}
        set -e argv[1]
      case '-*' ${CODEX_NONINTERACTIVE_COMMANDS.join(' ')}
        return 1
      case '*'
        return 0
    end
  end
  return 0
end`
}
