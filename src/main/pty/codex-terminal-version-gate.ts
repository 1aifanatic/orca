import { CODEX_NO_DAEMON_FIRST_VERSION } from '../../shared/codex-terminal-launch-policy'

// Why probed in the pane: a version-manager shim picks its Codex from the pane's
// cwd and env, so only a probe run there, right before launch, can prove support.
// Only an exact `codex-cli X.Y.Z[-pre]` line counts; anything else keeps today's launch.
const [FIRST_MAJOR, FIRST_MINOR] = CODEX_NO_DAEMON_FIRST_VERSION.split('.').map(Number)
const VERSION_BODY = 'codex-cli ([0-9]{1,9})\\.([0-9]{1,9})\\.[0-9]{1,9}(-[0-9A-Za-z.]+)?'

export function posixCodexVersionGate(): string {
  return `__orca_codex_supports_no_daemon() {
  local __orca_out __orca_rest __orca_major __orca_minor __orca_patch __orca_part
  __orca_out="$("$1" --version </dev/null 2>/dev/null)" || return 1
  __orca_out=\${__orca_out%$'\\r'}
  case "$__orca_out" in "codex-cli "*.*.*) ;; *) return 1 ;; esac
  __orca_rest=\${__orca_out#codex-cli }
  __orca_major=\${__orca_rest%%.*}
  __orca_rest=\${__orca_rest#*.}
  __orca_minor=\${__orca_rest%%.*}
  __orca_rest=\${__orca_rest#*.}
  __orca_patch=\${__orca_rest%%-*}
  __orca_rest=\${__orca_rest#"$__orca_patch"}
  for __orca_part in "$__orca_major" "$__orca_minor" "$__orca_patch"; do
    case "$__orca_part" in ''|*[!0-9]*|??????????*) return 1 ;; esac
  done
  case "$__orca_rest" in '') ;; -|-*[!0-9A-Za-z.]*) return 1 ;; -*) ;; *) return 1 ;; esac
  [ "$__orca_major" -gt ${FIRST_MAJOR} ] || { [ "$__orca_major" -eq ${FIRST_MAJOR} ] && [ "$__orca_minor" -ge ${FIRST_MINOR} ]; }
}`
}

export function fishCodexVersionGate(): string {
  return `function __orca_codex_supports_no_daemon
  set -l out (command $argv[1] --version </dev/null 2>/dev/null); or return 1
  test (count $out) -eq 1; or return 1
  set -l parts (string match -r -- '^${VERSION_BODY}\\r?$' $out); or return 1
  test $parts[2] -gt ${FIRST_MAJOR}; or begin; test $parts[2] -eq ${FIRST_MAJOR}; and test $parts[3] -ge ${FIRST_MINOR}; end
end`
}

export function powerShellCodexVersionGate(): string {
  return `function Global:__OrcaCodexSupportsNoDaemon {
    param([string]$Executable)
    try {
        $global:LASTEXITCODE = 0
        $out = @(& $Executable --version 2>$null)
    } catch {
        return $false
    }
    if ($LASTEXITCODE -ne 0 -or $out.Count -ne 1) { return $false }
    if ("$($out[0])".TrimEnd("\`r") -cmatch '^${VERSION_BODY}$') {
        $major = [int]$Matches[1]
        return ($major -gt ${FIRST_MAJOR} -or ($major -eq ${FIRST_MAJOR} -and [int]$Matches[2] -ge ${FIRST_MINOR}))
    }
    return $false
}`
}
