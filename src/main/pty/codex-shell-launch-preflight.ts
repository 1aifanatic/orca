import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'

const DEV_LAUNCHER_DIR = ['cli', 'bin']
const DEV_COMMAND_NAME = 'orca-dev'

export type CodexShellLaunchPreflightCommandOptions = {
  hooksEnabled: boolean
  isPackaged: boolean
  isWsl?: boolean
  managedHomePath: string | null
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
  if (!options.hooksEnabled || !options.managedHomePath) {
    return null
  }
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

// Why --no-daemon: from 0.156 Codex joins (0.157+ also starts) one shared server per
// CODEX_HOME that runs every tab's hooks and tools with the first tab's Orca env and
// dies with that tab (#22873). agents/queue need that server; --remote or a second
// --no-daemon make Codex exit 2. ORCA_CODEX_ISOLATE=0 opts out.
export function getPosixCodexShellLaunchPreflight(options: { hookPrep?: boolean } = {}): string {
  const hookPrep =
    options.hookPrep === false
      ? ''
      : `    if [[ -n "\${ORCA_CODEX_LAUNCH_PREFLIGHT:-}" && -x "\${ORCA_CODEX_LAUNCH_PREFLIGHT}" ]]; then
      "\${ORCA_CODEX_LAUNCH_PREFLIGHT}" agent hooks prepare-codex >/dev/null 2>&1 || :
    fi
`
  return `# Why: a typed alias expands inside the shell, after pane launch prep.
# Why unalias inside the substitution: an alias named codex makes command -v
# report the alias text, and the subshell leaves the user's own alias intact.
# Why || : twice — zsh alone aborts inside the substitution, but every shell's
# assignment adopts its exit status, so an absent codex trips set -e in bash too.
__orca_codex_binary="$(unalias codex 2>/dev/null || :; command -v codex 2>/dev/null || :)"
if [[ -n "\${__orca_codex_binary:-}" && -x "\${__orca_codex_binary}" ]]; then
  # Why the function reserved word: it suppresses alias expansion of the name,
  # which otherwise rewrites this header at parse time and aborts the whole file.
  function codex {
    # Why local: zsh's warn_create_global warns for each global a function creates.
    local __orca_codex_arg __orca_codex_isolate="\${ORCA_CODEX_ISOLATE:-1}"
${hookPrep}    for __orca_codex_arg in "$@"; do
      case "$__orca_codex_arg" in agents|queue|--no-daemon|--remote|--remote=*) __orca_codex_isolate=0 ;; esac
    done
    # Why probe every launch: a cached answer goes stale across an upgrade, and 0.155 and older exit 2 on the flag.
    if [[ "$__orca_codex_isolate" != 0 ]]; then
      case "$(command codex --help 2>/dev/null </dev/null)" in *--no-daemon*) ;; *) __orca_codex_isolate=0 ;; esac
    fi
    if [[ "$__orca_codex_isolate" != 0 ]]; then
      command codex --no-daemon "$@"
    else
      command codex "$@"
    fi
  }
fi
unset __orca_codex_binary
`
}

export function getFishCodexShellLaunchPreflight(): string {
  return `# Why captured: an unquoted (type -t codex) expands to zero words when codex is
# absent, leaving "test = file" — fish then errors instead of failing closed.
# Quoting in place is not the fix; fish never substitutes inside double quotes.
set -l __orca_codex_type (type -t codex 2>/dev/null)
if test "$__orca_codex_type" = file
  function codex
    if test -x "$ORCA_CODEX_LAUNCH_PREFLIGHT"
      command "$ORCA_CODEX_LAUNCH_PREFLIGHT" agent hooks prepare-codex >/dev/null 2>&1; or true
    end
    if test "$ORCA_CODEX_ISOLATE" != 0; and not string match -qr -- '^(agents|queue|--no-daemon|--remote(=.*)?)$' $argv; and command codex --help 2>/dev/null </dev/null | string match -q -- '*--no-daemon*'
      command codex --no-daemon $argv
    else
      command codex $argv
    end
  end
end
set -e __orca_codex_type`
}

export function getPowerShellCodexShellLaunchPreflight(): string {
  return `$orcaCodexCommand = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1
if ($orcaCodexCommand -and
    $orcaCodexCommand.CommandType -in @("Application", "ExternalScript")) {
    function Global:codex {
        $orcaCodexExecutable = Get-Command codex -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $orcaCodexExecutable) {
            Write-Error "codex executable not found"
            $global:LASTEXITCODE = 127
            return
        }
        $orcaCodexArgs = $args
        # Why a child scope: the user's StrictMode and ErrorActionPreference must not
        # abort hook prep or the flag probe, and neither may leak its exit code.
        $orcaCodexFlags = @(& {
            Set-StrictMode -Off
            $ErrorActionPreference = 'Continue'
            $PSNativeCommandUseErrorActionPreference = $false
            $priorExitCode = $global:LASTEXITCODE
            if ($env:ORCA_CODEX_LAUNCH_PREFLIGHT) {
                try {
                    & $env:ORCA_CODEX_LAUNCH_PREFLIGHT agent hooks prepare-codex *> $null
                } catch {
                }
            }
            if ($env:ORCA_CODEX_ISOLATE -ne '0' -and
                -not ($orcaCodexArgs | Where-Object { $_ -cin 'agents', 'queue', '--no-daemon', '--remote' -or "$_" -clike '--remote=*' }) -and
                ((& $orcaCodexExecutable.Source --help 2>$null) -match '--no-daemon')) {
                '--no-daemon'
            }
            $global:LASTEXITCODE = $priorExitCode
        })
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
