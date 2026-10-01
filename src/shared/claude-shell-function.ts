import { claudeProfileRoutingEnabled } from './claude-profile-routing'
const authHeaderWords = 'authorization|x-api-key|api-key|bearer'
const posixAuthHeaderPattern = authHeaderWords
  .split('|')
  .map((word) => `*${word.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`)}*`)
  .join('|')

/** These functions are inserted only when profile routing is enabled. */
export function getPosixClaudeShellFunction(options: { optionalAuthority?: boolean } = {}): string {
  if (!claudeProfileRoutingEnabled()) {
    return ''
  }
  const body = `function claude {
  local __orca_claude_home
  if [ -z "\${ORCA_CLAUDE_PROFILE_POINTER:-}" ] || [ ! -f "$ORCA_CLAUDE_PROFILE_POINTER" ] || [ ! -r "$ORCA_CLAUDE_PROFILE_POINTER" ]; then
    printf '%s\\n' 'Claude account selection is unreadable; choose an account again.' >&2; return 1
  fi
  __orca_claude_home="$(LC_ALL=C tr '\\000' '\\n' < "$ORCA_CLAUDE_PROFILE_POINTER" && printf '.')" || { printf '%s\\n' 'Claude account selection is unreadable.' >&2; return 1; }
  __orca_claude_home="\${__orca_claude_home%.}"
  case "$__orca_claude_home" in *$'\\n'*|*$'\\r'*) printf '%s\\n' 'Invalid Claude account selection.' >&2; return 1 ;; esac
  if [ -n "$__orca_claude_home" ]; then
    case "$__orca_claude_home" in /*) ;; *) printf '%s\\n' 'Invalid Claude account selection.' >&2; return 1 ;; esac
    if [ ! -d "$__orca_claude_home" ]; then printf '%s\\n' 'Selected Claude profile is missing.' >&2; return 1; fi
    ( unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN AWS_BEARER_TOKEN_BEDROCK; case "\${ANTHROPIC_CUSTOM_HEADERS:-}" in ${posixAuthHeaderPattern}) unset ANTHROPIC_CUSTOM_HEADERS ;; esac; export CLAUDE_CONFIG_DIR="$__orca_claude_home"; command claude "$@" )
  else
    ( unset CLAUDE_CONFIG_DIR; command claude "$@" )
  fi
}
`
  return options.optionalAuthority
    ? `if [ -n "\${ORCA_CLAUDE_PROFILE_POINTER:-}" ]; then\n${body}fi\n`
    : body
}

export function getFishClaudeShellFunction(): string {
  if (!claudeProfileRoutingEnabled()) {
    return ''
  }
  return `function claude
  if not set -q ORCA_CLAUDE_PROFILE_POINTER; or not test -f "$ORCA_CLAUDE_PROFILE_POINTER"; or not test -r "$ORCA_CLAUDE_PROFILE_POINTER"
    echo 'Claude account selection is unreadable; choose an account again.' >&2; return 1
  end
  set -l profile (cat -- "$ORCA_CLAUDE_PROFILE_POINTER" | string collect --allow-empty --no-trim-newlines)
  if test $pipestatus[1] -ne 0
    echo 'Claude account selection is unreadable.' >&2; return 1
  end
  if string match -qr '[\\r\\n]' -- "$profile"
    echo 'Invalid Claude account selection.' >&2; return 1
  end
  if test -n "$profile"
    if not string match -q '/*' -- "$profile"; or not test -d "$profile"
      echo 'Selected Claude profile is missing or invalid.' >&2; return 1
    end
    set -l headers
    if string match -irq '${authHeaderWords}' -- "$ANTHROPIC_CUSTOM_HEADERS"
      set headers -u ANTHROPIC_CUSTOM_HEADERS
    end
    env $headers -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN -u AWS_BEARER_TOKEN_BEDROCK CLAUDE_CONFIG_DIR="$profile" claude $argv
  else
    env -u CLAUDE_CONFIG_DIR claude $argv
  end
end
`
}

export function getPowerShellClaudeShellFunction(): string {
  if (!claudeProfileRoutingEnabled()) {
    return ''
  }
  return `function Global:claude {
    $saved = @{}
    $names = @('CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_CUSTOM_HEADERS')
    foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        if (-not $env:ORCA_CLAUDE_PROFILE_POINTER) { throw 'Claude account selection is unreadable.' }
        $profile = [IO.File]::ReadAllText($env:ORCA_CLAUDE_PROFILE_POINTER)
        if ($profile) {
            if ($profile -match '[\\r\\n\\x00]' -or -not [IO.Path]::IsPathRooted($profile) -or -not [IO.Directory]::Exists($profile)) { throw 'Selected Claude profile is missing or invalid.' }
            foreach ($name in $names) {
                if ($name -ne 'ANTHROPIC_CUSTOM_HEADERS' -or $env:ANTHROPIC_CUSTOM_HEADERS -match '${authHeaderWords}') { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
            }
            $env:CLAUDE_CONFIG_DIR = $profile
        } else { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
        $binary = Get-Command claude -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1
        if ($MyInvocation.ExpectingInput) { $input | & $binary.Source @args } else { & $binary.Source @args }
        $global:LASTEXITCODE = $LASTEXITCODE
    } catch { $global:LASTEXITCODE = 1; Write-Error $_ -ErrorAction Continue }
    finally { foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') } }
}
`
}
