import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'
import { quotePowerShellLiteral } from '../../shared/powershell-native-argument'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'
import {
  fishCodexInteractiveArgv,
  posixCodexInteractiveArgv,
  powerShellCodexInteractiveArgv
} from './codex-terminal-argv-policy'
import {
  fishCodexNoDaemonProbe,
  posixCodexNoDaemonProbe,
  powerShellCodexNoDaemonProbe
} from './codex-terminal-no-daemon-probe'

const DEV_LAUNCHER_DIR = ['cli', 'bin']
const DEV_COMMAND_NAME = 'orca-dev'

export type CodexShellLaunchPreflightCommandOptions = {
  isPackaged: boolean
  isWsl?: boolean
  /** Where the dev launcher is written; `join(userDataPath, 'cli', 'bin')` is also what managed dev PTYs prepend to PATH. */
  userDataPath: string
  /** Packaged app resources root; the bundled launcher lives under it. */
  resourcesPath?: string | null
  /** Test seam. */
  platform?: NodeJS.Platform
}

/** Absolute path of the Orca CLI the preflight must execute, or null to skip it.
 *
 *  Why absolute: the value rides in ORCA_CODEX_LAUNCH_PREFLIGHT and is invoked
 *  from the codex() wrapper, which shell-ready emits *after* the user's profile
 *  scripts run. Those scripts routinely rewrite PATH, so an unqualified name
 *  would be resolved against a PATH Orca neither controls nor can predict —
 *  handing Orca's managed Codex environment to an unidentified program. When no
 *  path verifies, skipping the preflight is the predictable degradation. */
export function resolveCodexShellLaunchPreflightCommand(
  options: CodexShellLaunchPreflightCommandOptions
): string | null {
  const platform = options.platform ?? process.platform
  const candidate = options.isPackaged
    ? options.resourcesPath
      ? getBundledLauncherPath(platform, options.resourcesPath)
      : null
    : join(
        options.userDataPath,
        ...DEV_LAUNCHER_DIR,
        platform === 'win32' ? `${DEV_COMMAND_NAME}.cmd` : DEV_COMMAND_NAME
      )
  if (!candidate || !isExecutableFileOnDisk(candidate, platform)) {
    return null
  }
  if (!options.isWsl) {
    return candidate
  }
  // Why: WSLENV /p translates the verified Windows launcher with the distro's configured automount root.
  return platform === 'win32' && options.isPackaged ? candidate : null
}

function isExecutableFileOnDisk(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false
    }
    // Why: Windows has no exec bit, so a readable launcher file is the strongest signal available.
    accessSync(path, platform === 'win32' ? constants.R_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function getPosixCodexShellLaunchPreflight(): string {
  return `${posixCodexInteractiveArgv()}
${posixCodexNoDaemonProbe()}
__orca_codex_path() {
  # Why local: zsh's warn_create_global prints a warning for each global a function creates.
  local _orca_lookup_command _orca_lookup_candidate _orca_lookup_remaining _orca_lookup_component _orca_lookup_has_more __orca_lookup_result
${buildPosixCommandPathLookupScript({ kind: 'literal', value: 'codex' }, { resultVariable: '__orca_lookup_result' })}
  printf '%s' "$__orca_lookup_result"
}
# Why: a typed alias expands inside the shell, after pane launch prep.
# Why unalias inside the substitution: an alias named codex makes command -v
# report the alias text, and the subshell leaves the user's own alias intact.
# Why || : twice — zsh alone aborts inside the substitution, but every shell's
# assignment adopts its exit status, so an absent codex trips set -e in bash too.
__orca_codex_binary="$(unalias codex 2>/dev/null || :; command -v codex 2>/dev/null || :)"
if [[ -n "\${ORCA_CODEX_LAUNCH_POLICY:-}" && -n "\${__orca_codex_binary:-}" && -x "\${__orca_codex_binary}" ]]; then
  # Why the function reserved word: it suppresses alias expansion of the name,
  # which otherwise rewrites this header at parse time and aborts the whole file.
  function codex {
    local __orca_executable
    # Why gated: hook prep only repairs an Orca-managed home, and needs a launcher this shell can run.
    if [ -n "\${ORCA_CODEX_HOME:-}" ] && [ -n "\${ORCA_CODEX_LAUNCH_PREFLIGHT:-}" ] && [ -x "\${ORCA_CODEX_LAUNCH_PREFLIGHT}" ]; then
      "\${ORCA_CODEX_LAUNCH_PREFLIGHT}" agent hooks prepare-codex >/dev/null 2>&1 || :
    fi
    __orca_executable="$(__orca_codex_path)"
    if [ -n "$__orca_executable" ] && [ -x "$__orca_executable" ] && __orca_codex_interactive "$@" && __orca_codex_supports_no_daemon "$__orca_executable"; then
      "$__orca_executable" --no-daemon "$@"
      return $?
    fi
    command codex "$@"
  }
fi
unset __orca_codex_binary
`
}

export function getFishCodexShellLaunchPreflight(): string {
  return `${fishCodexInteractiveArgv()}
${fishCodexNoDaemonProbe()}
# Why captured: an unquoted (type -t codex) expands to zero words when codex is
# absent, leaving "test = file" — fish then errors instead of failing closed.
# Quoting in place is not the fix; fish never substitutes inside double quotes.
set -l __orca_codex_type (type -t codex 2>/dev/null)
if test -n "$ORCA_CODEX_LAUNCH_POLICY"; and test "$__orca_codex_type" = file
  function codex
    if test -n "$ORCA_CODEX_HOME"; and test -x "$ORCA_CODEX_LAUNCH_PREFLIGHT"
      command "$ORCA_CODEX_LAUNCH_PREFLIGHT" agent hooks prepare-codex >/dev/null 2>&1; or true
    end
    set -l executable (command -v codex 2>/dev/null)
    if test -n "$executable"; and __orca_codex_interactive $argv; and __orca_codex_supports_no_daemon "$executable"
      command "$executable" --no-daemon $argv
      return $status
    end
    command codex $argv
  end
end
set -e __orca_codex_type`
}

// Why one helper with pinned preferences: the user's StrictMode and $ErrorActionPreference
// (5.1: Stop on any stderr line) must not cut Orca's own steps short; only the launch keeps them.
// Why $LASTEXITCODE is restored: prep and the probe must not leak their status past a Codex the
// shell refuses to run (a policy-blocked codex.ps1).
export function getPowerShellCodexShellLaunchPreflight(): string {
  return `${powerShellCodexInteractiveArgv()}
${powerShellCodexNoDaemonProbe()}
$orcaCodexCommand = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1
if ($env:ORCA_CODEX_LAUNCH_POLICY -and $orcaCodexCommand -and
    $orcaCodexCommand.CommandType -in @("Application", "ExternalScript")) {
    function Global:__OrcaCodexLaunchFlags {
        param([string]$Executable, [string[]]$Tokens)
        Set-StrictMode -Off
        $ErrorActionPreference = 'Continue'
        $PSNativeCommandUseErrorActionPreference = $false
        $priorExitCode = $global:LASTEXITCODE
        if ($env:ORCA_CODEX_HOME -and $env:ORCA_CODEX_LAUNCH_PREFLIGHT) {
            try {
                & $env:ORCA_CODEX_LAUNCH_PREFLIGHT agent hooks prepare-codex *> $null
            } catch {
            }
        }
        if ((__OrcaCodexInteractive -Tokens $Tokens) -and (__OrcaCodexSupportsNoDaemon $Executable)) {
            '--no-daemon'
        }
        $global:LASTEXITCODE = $priorExitCode
    }
    function Global:codex {
        $orcaCodexExecutable = Get-Command codex -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $orcaCodexExecutable) {
            Write-Error "codex executable not found"
            $global:LASTEXITCODE = 127
            return
        }
        $orcaCodexFlags = @(__OrcaCodexLaunchFlags -Executable $orcaCodexExecutable.Source -Tokens $args)
        # Why: a native command inside a function never sees the function's pipeline input on its own.
        if ($MyInvocation.ExpectingInput) {
            $input | & $orcaCodexExecutable.Source @orcaCodexFlags @args
        } else {
            & $orcaCodexExecutable.Source @orcaCodexFlags @args
        }
        $global:LASTEXITCODE = $LASTEXITCODE
    }
}
Remove-Variable orcaCodexCommand -ErrorAction SilentlyContinue`
}

// Why ScriptBlock over dot-sourcing the path: execution policy gates script
// files, never inline text, so this reaches Restricted/AllSigned hosts as the
// inlined wrapper does.
export function getPowerShellCodexShellLaunchPreflightLoader(scriptPath: string): string {
  return `try { . ([ScriptBlock]::Create([IO.File]::ReadAllText(${quotePowerShellLiteral(scriptPath)}))) } catch { Write-Error $_ -ErrorAction Continue }`
}
