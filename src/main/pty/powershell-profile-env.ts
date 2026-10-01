import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expandWindowsEnvironmentVariables } from '../../shared/windows-environment-expansion'
import { loadWindowsNativeRegistry } from '../windows-native-registry'

// Why both editions: a pane may run Windows PowerShell 5.1 or PowerShell 7, and
// each loads its own profiles. Within one, $PSHOME's load before the user's.
const POWERSHELL_EDITIONS = [
  {
    documentsSubdir: 'WindowsPowerShell',
    psHome: (env: NodeJS.ProcessEnv) =>
      join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')
  },
  {
    documentsSubdir: 'PowerShell',
    psHome: (env: NodeJS.ProcessEnv) =>
      join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7')
  }
] as const
const PROFILE_FILES = ['profile.ps1', 'Microsoft.PowerShell_profile.ps1']
const USER_SHELL_FOLDERS_KEY =
  'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'

const cache = new Map<string, string[]>()

/**
 * Every value a PowerShell profile assigns to `$env:<name>`, in load order, read
 * as text. Spawning PowerShell to evaluate the profiles would run user code and
 * reads as suspicious to EDR (docs/reference/windows-edr-posture.md).
 *
 * Same fidelity as the POSIX rc-file probe: only `$env:NAME = value` and
 * `${env:NAME} = value` lines, no conditionals or dot-sourced files. `$HOME`
 * and `$env:USERPROFILE` expand in double-quoted and bare values; any other
 * expression is returned verbatim, which callers comparing against a known
 * path read as "something else".
 *
 * Memoized: profiles don't change under a running Orca often enough to pay a
 * re-read on every routing check.
 */
export function readPowerShellProfileEnvAssignments(
  name: string,
  userProfile: string,
  env: NodeJS.ProcessEnv = process.env,
  documentsDir?: string | null
): string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return []
  }
  const cacheKey = `${name.toLowerCase()}\0${userProfile}\0${documentsDir ?? ''}`
  const cached = cache.get(cacheKey)
  if (cached) {
    return cached
  }
  const assignment = new RegExp(`^(?:\\$env:${name}|\\$\\{env:${name}\\})\\s*=\\s*(.+)$`, 'i')
  const values: string[] = []
  const profilePaths = powerShellProfilePaths(
    userProfile,
    env,
    documentsDir === undefined ? readRegistryDocumentsDir(env) : documentsDir
  )
  for (const path of profilePaths) {
    const content = readProfile(path)
    for (const rawLine of content?.split(/\r?\n/) ?? []) {
      const value = assignment.exec(rawLine.trim())?.[1]
      const parsed = value === undefined ? '' : parsePowerShellValue(value, userProfile)
      if (parsed) {
        values.push(parsed)
      }
    }
  }
  cache.set(cacheKey, values)
  return values
}

function powerShellProfilePaths(
  userProfile: string,
  env: NodeJS.ProcessEnv,
  documentsDir: string | null
): string[] {
  // Why both: the registry names the real (often OneDrive-redirected) folder,
  // and the default location still counts when that read fails.
  const documentsDirs = [...new Set([documentsDir, join(userProfile, 'Documents')])].filter(
    (dir): dir is string => Boolean(dir)
  )
  return POWERSHELL_EDITIONS.flatMap((edition) => [
    ...PROFILE_FILES.map((file) => join(edition.psHome(env), file)),
    ...documentsDirs.flatMap((dir) =>
      PROFILE_FILES.map((file) => join(dir, edition.documentsSubdir, file))
    )
  ])
}

// Why the registry: $PROFILE hangs off the Documents known folder, which
// OneDrive or a policy can move anywhere; this is the same value it resolves.
function readRegistryDocumentsDir(env: NodeJS.ProcessEnv): string | null {
  try {
    const registry = loadWindowsNativeRegistry()
    const personal = registry.getRegistryKey(registry.HK.CU, USER_SHELL_FOLDERS_KEY)?.Personal
    return typeof personal?.value === 'string'
      ? expandWindowsEnvironmentVariables(personal.value, env)
      : null
  } catch {
    return null
  }
}

function readProfile(path: string): string | null {
  try {
    // Why strip the BOM: PowerShell 5.1's editor saves profiles as UTF-8 with one.
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

function parsePowerShellValue(raw: string, userProfile: string): string {
  const value = stripTrailingComment(raw).trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (/^\$null$/i.test(value)) {
    return ''
  }
  const text =
    value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
  // Why word boundaries: `$HOMEPATH` or `$env:USERPROFILEX` must not half-expand.
  return text
    .replace(/\$\{?HOME\}?(?![A-Za-z0-9_])/gi, userProfile)
    .replace(/\$\{?env:USERPROFILE\}?(?![A-Za-z0-9_])/gi, userProfile)
}

function stripTrailingComment(value: string): string {
  // Why: `#` starts a comment only outside quotes and at a token start.
  let quote: string | null = null
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (quote) {
      quote = ch === quote ? null : quote
    } else if (ch === "'" || ch === '"') {
      quote = ch
    } else if (ch === '#' && (i === 0 || /\s/.test(value[i - 1] ?? ''))) {
      return value.slice(0, i)
    }
  }
  return value
}

/** Test-only: profiles never change within a test process otherwise. */
export function __resetPowerShellProfileEnvCache(): void {
  cache.clear()
}
