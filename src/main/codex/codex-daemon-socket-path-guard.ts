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
 * function; this is the backup for every other launch (cmd.exe, scripts, absolute
 * paths) in homes Orca owns: those homes never auto-start the server. It cannot
 * stop joining one that is already running; see codex-shared-server-probe.ts.
 * Long homes also exceed `sun_path`, so there Codex cannot start at all otherwise.
 */
const DAEMON_SOCKET_SEGMENTS = ['app-server-control', 'app-server-control.sock']
export const CODEX_DAEMON_OVERRIDE_MARKER = '# orca: no shared Codex server in an Orca-owned home'
// Why: homes guarded before this marker was reworded still carry it; Orca must keep recognizing its own line.
const LEGACY_CODEX_DAEMON_OVERRIDE_MARKERS = ['# orca: CODEX_HOME too long for the daemon socket']
const CODEX_DAEMON_OVERRIDE_MARKERS = [
  CODEX_DAEMON_OVERRIDE_MARKER,
  ...LEGACY_CODEX_DAEMON_OVERRIDE_MARKERS
]
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

/**
 * Applies Orca's daemon override to a home Orca owns. Whose setting wins: an
 * explicit `daemon_auto_start` the user wrote (mirrored from ~/.codex or set in
 * this home) is kept, because only the socket limit makes a shared server
 * impossible rather than unwanted. `ORCA_CODEX_ISOLATE` is a pane variable the
 * host cannot see, so it governs only #23900's `--no-daemon`, never this file.
 */
export function applyCodexDaemonSocketGuard(
  config: string,
  homePath: string,
  platform = process.platform
): string {
  // Why: the user's own home is theirs to configure; Orca writes only into homes it created.
  if (isUserCodexHome(homePath)) {
    return stripCodexDaemonOverride(config)
  }
  const socketTooLong = codexDaemonSocketPathExceedsLimit(homePath, platform)
  if (!socketTooLong && hasUserDaemonAutoStartSetting(config)) {
    return stripCodexDaemonOverride(config)
  }
  // Why: upsert rewrites an existing daemon_auto_start line in place, so re-applying is a no-op.
  const guarded = upsertTableSettingsInContent(
    config,
    'features',
    new Map([['daemon_auto_start', DAEMON_OVERRIDE_RAW]])
  )
  if (
    !guarded.includes(CODEX_DAEMON_OVERRIDE_MARKER) &&
    !/\bdaemon_auto_start\s*=\s*false\b/.test(guarded) &&
    !unguardableHomesWarned.has(homePath)
  ) {
    // Why: an inline `features = {...}` or `[[features]]` blocks the upsert; say so once instead of failing silently.
    unguardableHomesWarned.add(homePath)
    const consequence = socketTooLong
      ? 'Codex may fail with "path must be shorter than SUN_LEN"'
      : "Codex may start a shared background server that runs every tab's hooks with one tab's environment"
    console.warn(
      `[codex-config] Could not turn off Codex daemon auto-start in ${homePath}: its config defines features in a form Orca cannot extend. ${consequence}; add daemon_auto_start = false to features in ~/.codex/config.toml.`
    )
  }
  return guarded
}

// Why: Orca's own homes all end in `home`; a `.codex` home is the user's even if a caller mis-routes it here.
function isUserCodexHome(homePath: string): boolean {
  const spelled = parseWslUncPath(homePath)?.linuxPath ?? homePath
  return (
    spelled
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) === '.codex'
  )
}

function isCodexDaemonOverrideLine(line: string): boolean {
  const trimmed = line.trimEnd()
  return CODEX_DAEMON_OVERRIDE_MARKERS.some((marker) => trimmed.endsWith(marker))
}

/** True when a `features.daemon_auto_start` value that Orca did not write is present. */
function hasUserDaemonAutoStartSetting(config: string): boolean {
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
    if (inFeatures && path === 'daemon_auto_start') {
      return true
    }
    if (inPreamble && path === 'features.daemon_auto_start') {
      return true
    }
    // Why: Orca never writes an inline features table, so a key inside one is the user's.
    if (inPreamble && path === 'features' && /\bdaemon_auto_start\s*=/.test(line.slice(key.end))) {
      return true
    }
  }
  return false
}

/** True when a config holds nothing but Orca's daemon override, i.e. no user settings. */
export function isOnlyCodexDaemonOverride(config: string): boolean {
  return hasCodexDaemonOverrideMarker(config) && stripCodexDaemonOverride(config).trim() === ''
}

/**
 * Removes only lines Orca wrote, plus a `[features]` table left empty by that
 * removal, so the override never leaks into the user's real ~/.codex.
 */
export function stripCodexDaemonOverride(config: string): string {
  if (!hasCodexDaemonOverrideMarker(config)) {
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

function hasCodexDaemonOverrideMarker(config: string): boolean {
  return CODEX_DAEMON_OVERRIDE_MARKERS.some((marker) => config.includes(marker))
}
