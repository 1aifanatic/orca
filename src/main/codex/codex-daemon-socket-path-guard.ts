import { realpathSync } from 'node:fs'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { unixSocketPathByteLimit } from '../../shared/unix-socket-path-limit'
import { upsertTableSettingsInContent } from './codex-config-settings-upsert'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  joinPreservingTrailingNewline,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'

/**
 * Codex >= 0.157 auto-starts one shared app-server per CODEX_HOME that runs every
 * later session's hooks and tools with the first session's environment and dies
 * with it. #23900's `--no-daemon` covers launches through Orca's `codex` shell
 * function; this is the backup for launches that skip it (cmd.exe, scripts,
 * absolute paths) in homes Orca owns, which never auto-start the server. It does
 * not stop a launch joining a server already running there. Long homes also
 * exceed `sun_path`, where Codex cannot start at all without it; most account
 * homes are that long, so the new reach is mainly the shared runtime home on
 * Windows, and on Linux when it is not on the real-home lane.
 */
const DAEMON_SOCKET_SEGMENTS = ['app-server-control', 'app-server-control.sock']
// Why: older Orca builds strip only this exact text, so it must never change.
export const CODEX_DAEMON_OVERRIDE_MARKER = '# orca: CODEX_HOME too long for the daemon socket'
const DAEMON_OVERRIDE_RAW = `false ${CODEX_DAEMON_OVERRIDE_MARKER}`

export function codexDaemonSocketPath(homePath: string, platform = process.platform): string {
  const wsl = parseWslUncPath(homePath)
  if (wsl) {
    return [wsl.linuxPath.replace(/\/+$/, ''), ...DAEMON_SOCKET_SEGMENTS].join('/')
  }
  // Why: Codex canonicalizes CODEX_HOME before building the socket path, so a
  // short symlinked alias still resolves to the long real path. Its
  // AbsolutePathBuf strips the Windows \\?\ prefix, so none is counted here.
  let canonical = homePath
  try {
    canonical = realpathSync.native(homePath)
  } catch {
    // Unresolvable homes are measured as spelled.
  }
  const separator = platform === 'win32' ? '\\' : '/'
  return [canonical.replace(/[\\/]+$/, ''), ...DAEMON_SOCKET_SEGMENTS].join(separator)
}

export function codexDaemonSocketPathExceedsLimit(
  homePath: string,
  platform = process.platform
): boolean {
  // Why: WSL homes run Linux Codex; Windows Codex's uds_windows also uses a 108-byte sun_path.
  const os = platform === 'darwin' && !parseWslUncPath(homePath) ? 'darwin' : 'linux'
  const socketPath = codexDaemonSocketPath(homePath, platform)
  return Buffer.byteLength(socketPath, 'utf8') > unixSocketPathByteLimit(os)
}

const unguardableHomesWarned = new Set<string>()
const overriddenHomesWarned = new Set<string>()

/**
 * Forces `daemon_auto_start = false` into a home Orca owns, even over a user's
 * explicit `true` mirrored from ~/.codex, matching the shell function, which adds
 * `--no-daemon` regardless of config. Callers pass only Orca's runtime homes; the
 * user's ~/.codex reaches the mirror solely as its read-only source. Profile-level
 * (`[profiles.X.features]`) and `-c` overrides still win; that is accepted.
 */
export function applyCodexDaemonSocketGuard(
  config: string,
  orcaOwnedHomePath: string,
  platform = process.platform
): string {
  // Why: upsert rewrites an existing daemon_auto_start line in place, so re-applying is a no-op.
  const guarded = upsertTableSettingsInContent(
    config,
    'features',
    new Map([['daemon_auto_start', DAEMON_OVERRIDE_RAW]])
  )
  const applied = guarded.includes(CODEX_DAEMON_OVERRIDE_MARKER)
  if (applied && hasUserDaemonAutoStartEnabled(config)) {
    warnOncePerHome(
      overriddenHomesWarned,
      orcaOwnedHomePath,
      `[codex-config] A Codex config sets features.daemon_auto_start = true; Orca turns it off in its own Codex home ${orcaOwnedHomePath} so each Orca tab runs its own Codex server. Orca never edits ~/.codex/config.toml; a value set only inside ${orcaOwnedHomePath} is replaced there.`
    )
  }
  if (!applied && !/\bdaemon_auto_start\s*=\s*false\b/.test(guarded)) {
    const consequence = codexDaemonSocketPathExceedsLimit(orcaOwnedHomePath, platform)
      ? 'Codex may fail with "path must be shorter than SUN_LEN"'
      : "Codex may start a shared background server that runs every tab's hooks with one tab's environment"
    // Why: an inline `features = {...}` or `[[features]]` blocks the upsert; say so once instead of failing silently.
    warnOncePerHome(
      unguardableHomesWarned,
      orcaOwnedHomePath,
      `[codex-config] Could not turn off Codex daemon auto-start in ${orcaOwnedHomePath}: its config defines features in a form Orca cannot extend. ${consequence}; rewrite features in ~/.codex/config.toml as a [features] table so Orca can add the setting to its own copy.`
    )
  }
  return guarded
}

function warnOncePerHome(warned: Set<string>, homePath: string, message: string): void {
  if (!warned.has(homePath)) {
    warned.add(homePath)
    console.warn(message)
  }
}

function isCodexDaemonOverrideLine(line: string): boolean {
  return line.trimEnd().endsWith(CODEX_DAEMON_OVERRIDE_MARKER)
}

/** True when the config sets `features.daemon_auto_start = true` in a line Orca did not write. */
function hasUserDaemonAutoStartEnabled(config: string): boolean {
  let scan = createTomlLineScanState()
  let inPreamble = true
  let inFeatures = false
  for (const line of config.split('\n')) {
    const structural = isTomlStructuralLine(scan)
    scan = updateTomlLineScanState(scan, line)
    if (!structural) {
      continue
    }
    const header = getTomlTableHeader(line)
    if (header) {
      const table = parseTomlTableHeaderPath(header)
      inPreamble = false
      inFeatures = table?.isArray === false && table.segments.join('.') === 'features'
      continue
    }
    const key = parseTomlKeyPath(line)
    if (!key || line[key.end] !== '=' || isCodexDaemonOverrideLine(line)) {
      continue
    }
    const path = key.segments.join('.')
    const value = line.slice(key.end + 1)
    if (
      ((inFeatures && path === 'daemon_auto_start') ||
        (inPreamble && path === 'features.daemon_auto_start')) &&
      /^\s*true\b/.test(value)
    ) {
      return true
    }
    if (inPreamble && path === 'features' && /\bdaemon_auto_start\s*=\s*true\b/.test(value)) {
      return true
    }
  }
  return false
}

/** True when a config holds nothing but Orca's daemon override, i.e. no user settings. */
export function isOnlyCodexDaemonOverride(config: string): boolean {
  return (
    config.includes(CODEX_DAEMON_OVERRIDE_MARKER) && stripCodexDaemonOverride(config).trim() === ''
  )
}

/**
 * Removes only lines Orca wrote, plus a `[features]` table left empty by that
 * removal, so the override never leaks into the user's real ~/.codex.
 */
export function stripCodexDaemonOverride(config: string): string {
  if (!config.includes(CODEX_DAEMON_OVERRIDE_MARKER)) {
    return config
  }
  const usesCrlf = config.includes('\r\n')
  const lines = config.split('\n')
  const kept: string[] = []
  let featuresHeaderIndex = -1
  let removedFromFeatures = false
  const dropEmptyFeaturesTable = (): void => {
    const body = kept.slice(featuresHeaderIndex + 1)
    if (featuresHeaderIndex !== -1 && removedFromFeatures && body.every((l) => l.trim() === '')) {
      kept.length = featuresHeaderIndex
      while (kept.at(-1)?.trim() === '') {
        kept.pop()
      }
      if (kept.length > 0) {
        // Why: keep one blank line before the next table.
        kept.push(usesCrlf ? '\r' : '')
      }
    }
  }
  let scan = createTomlLineScanState()
  for (const line of lines) {
    const structural = isTomlStructuralLine(scan)
    scan = updateTomlLineScanState(scan, line)
    if (structural && isCodexDaemonOverrideLine(line)) {
      removedFromFeatures ||= featuresHeaderIndex !== -1
      continue
    }
    const header = structural ? getTomlTableHeader(line) : null
    if (header) {
      dropEmptyFeaturesTable()
      const table = parseTomlTableHeaderPath(header)
      const isFeatures = table?.isArray === false && table.segments.join('.') === 'features'
      featuresHeaderIndex = isFeatures ? kept.length : -1
      removedFromFeatures = false
    }
    kept.push(line)
  }
  dropEmptyFeaturesTable()
  while (kept.at(-1)?.trim() === '') {
    kept.pop()
  }
  return kept.length === 0 ? '' : joinPreservingTrailingNewline(kept, usesCrlf)
}
