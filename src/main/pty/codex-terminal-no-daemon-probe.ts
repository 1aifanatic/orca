// Why probed in the pane: a version-manager shim picks its Codex from the pane's
// cwd and env, so only a probe run there, right before launch, can prove support.
// Why exit status, not a version number: that Codex itself decides whether it
// accepts the flag, which also covers source builds and any later removal.
// Why --no-daemon first: clap stops at --version, so the reverse order passes
// even on a build that rejects the flag.

export function posixCodexNoDaemonProbe(): string {
  return `__orca_codex_supports_no_daemon() {
  "$1" --no-daemon --version </dev/null >/dev/null 2>&1
}`
}

export function fishCodexNoDaemonProbe(): string {
  return `function __orca_codex_supports_no_daemon
  command $argv[1] --no-daemon --version </dev/null >/dev/null 2>&1
end`
}

export function powerShellCodexNoDaemonProbe(): string {
  return `function Global:__OrcaCodexSupportsNoDaemon {
    param([string]$Executable)
    try {
        $global:LASTEXITCODE = 0
        & $Executable --no-daemon --version *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}`
}
