import { resolve } from 'node:path'
import { getSystemCodexHomePath } from './codex-home-paths'
import { readShellStartupEnvVar } from '../pty/shell-startup-env'
import { readPowerShellProfileEnvAssignments } from '../pty/powershell-profile-env'

export type CodexShellStartupHomeOverride = {
  home: string
  shell?: string
  /** Why recorded: fish reads config under it, so re-reads must use the same root. */
  configHome?: string
  codexHome: string
}

export type CodexEnvironmentHomeOverride = {
  codexHome: string
}

export type CustomCodexHomeOverrideForLaunch =
  | { source: 'environment'; context: CodexEnvironmentHomeOverride }
  | { source: 'shell-startup'; context: CodexShellStartupHomeOverride }

/** True when the user points Codex outside its standard native home. */
export function hasCustomCodexHomeOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  const codexHome = env.CODEX_HOME?.trim()
  const orcaCodexHome = env.ORCA_CODEX_HOME?.trim()
  const normalizedCodexHome = codexHome ? normalizePathForComparison(codexHome) : undefined
  const normalizedOrcaCodexHome = orcaCodexHome
    ? normalizePathForComparison(orcaCodexHome)
    : undefined
  // Why: phase 1 owns only ~/.codex and can clean that path on downgrade. A
  // custom home needs cross-home ownership tracking before Orca may mutate it.
  return Boolean(
    normalizedCodexHome &&
    normalizedCodexHome !== normalizedOrcaCodexHome &&
    normalizedCodexHome !== normalizePathForComparison(getSystemCodexHomePath())
  )
}

export function hasCustomCodexHomeOverrideForLaunch(launchEnv?: NodeJS.ProcessEnv): boolean {
  return getCustomCodexHomeOverrideForLaunch(launchEnv) !== null
}

export function getCustomCodexHomeOverrideForLaunch(
  launchEnv?: NodeJS.ProcessEnv
): CustomCodexHomeOverrideForLaunch | null {
  const effectiveEnv = launchEnv
    ? {
        CODEX_HOME: getLaunchEnvValue(launchEnv, 'CODEX_HOME'),
        ORCA_CODEX_HOME: getLaunchEnvValue(launchEnv, 'ORCA_CODEX_HOME')
      }
    : process.env
  if (hasCustomCodexHomeOverride(effectiveEnv)) {
    return {
      source: 'environment',
      context: { codexHome: effectiveEnv.CODEX_HOME!.trim() }
    }
  }
  const readLaunchEnv = (key: LaunchEnvKey): string | undefined =>
    launchEnv ? getLaunchEnvValue(launchEnv, key) : process.env[key]
  // Why USERPROFILE: Windows has no HOME, and PowerShell profiles hang off it.
  const home = readLaunchEnv(process.platform === 'win32' ? 'USERPROFILE' : 'HOME')
  const shell = readLaunchEnv('SHELL')
  const configHome = readLaunchEnv('XDG_CONFIG_HOME')
  const shellCodexHome = readShellStartupCodexHome(home, shell, configHome)
  if (!home || !shellCodexHome || !hasCustomCodexHomeOverride({ CODEX_HOME: shellCodexHome })) {
    return null
  }
  return {
    source: 'shell-startup',
    context: {
      home,
      ...(shell ? { shell } : {}),
      ...(configHome ? { configHome } : {}),
      codexHome: shellCodexHome
    }
  }
}

export function environmentCodexHomeOverrideContextsEqual(
  left: CodexEnvironmentHomeOverride,
  right: CodexEnvironmentHomeOverride
): boolean {
  return normalizePathForComparison(left.codexHome) === normalizePathForComparison(right.codexHome)
}

export function shellStartupCodexHomeOverrideMatches(
  context: CodexShellStartupHomeOverride,
  currentContext: CodexShellStartupHomeOverride = context
): boolean {
  if (!shellStartupCodexHomeOverrideContextsEqual(context, currentContext)) {
    return false
  }
  const currentCodexHome = readShellStartupCodexHome(
    currentContext.home,
    currentContext.shell,
    currentContext.configHome
  )
  return Boolean(
    currentCodexHome &&
    hasCustomCodexHomeOverride({ CODEX_HOME: currentCodexHome }) &&
    normalizePathForComparison(currentCodexHome) === normalizePathForComparison(context.codexHome)
  )
}

export function shellStartupCodexHomeOverrideContextsEqual(
  left: CodexShellStartupHomeOverride,
  right: CodexShellStartupHomeOverride
): boolean {
  return (
    normalizePathForComparison(left.home) === normalizePathForComparison(right.home) &&
    left.shell === right.shell &&
    left.configHome === right.configHome &&
    normalizePathForComparison(left.codexHome) === normalizePathForComparison(right.codexHome)
  )
}

/**
 * The CODEX_HOME the pane's shell startup would set. Windows panes may run
 * either PowerShell edition, so any profile pointing elsewhere counts.
 */
function readShellStartupCodexHome(
  home: string | undefined,
  shell: string | undefined,
  configHome: string | undefined
): string | undefined {
  if (process.platform !== 'win32') {
    return readShellStartupEnvVar('CODEX_HOME', home, shell, configHome)
  }
  return home
    ? readPowerShellProfileEnvAssignments('CODEX_HOME', home).find((codexHome) =>
        hasCustomCodexHomeOverride({ CODEX_HOME: codexHome })
      )
    : undefined
}

type LaunchEnvKey =
  | 'CODEX_HOME'
  | 'ORCA_CODEX_HOME'
  | 'HOME'
  | 'USERPROFILE'
  | 'SHELL'
  | 'XDG_CONFIG_HOME'

function getLaunchEnvValue(launchEnv: NodeJS.ProcessEnv, key: LaunchEnvKey): string | undefined {
  return Object.hasOwn(launchEnv, key) ? launchEnv[key] : process.env[key]
}

function normalizePathForComparison(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
