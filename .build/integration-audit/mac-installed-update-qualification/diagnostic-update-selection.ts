// Diagnostic-build overlay only; never included in a production source commit.
import { app } from 'electron'
import { lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { checkForUpdatesFromMenu, getRemoteServerUpdateSupport, getUpdateStatus } from '../updater'

type Selection = { id: string; manifest: string; fromVersion: string; targetVersion: string }
let pending: Selection | null = null
let activeRoot: string | null = null
let activeSecret: string | null = null
let claimed = false
const seen = new Set<string>()

function privateFile(path: string, directory = false): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || (!directory && stat.size > 16_384)) {
    throw new Error('diagnostic_control_not_private')
  }
}
function response(value: Record<string, unknown>): void {
  if (!activeRoot) return
  const path = join(activeRoot, 'update-response.json')
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}
function readSelection(): Selection | null {
  if (!activeRoot || !activeSecret) return null
  const file = join(activeRoot, 'update-request.json')
  try { privateFile(file) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!data || typeof data !== 'object' || !('secret' in data) || typeof data.secret !== 'string' ||
      !('id' in data) || typeof data.id !== 'string' || !/^[a-f0-9]{32}$/.test(data.id) ||
      !('manifest' in data) || typeof data.manifest !== 'string' ||
      !('fromVersion' in data) || typeof data.fromVersion !== 'string' ||
      !('targetVersion' in data) || typeof data.targetVersion !== 'string') throw new Error('diagnostic_request_invalid')
  const supplied = Buffer.from(data.secret), expected = Buffer.from(activeSecret)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('diagnostic_request_unauthorized')
  if (seen.has(data.id)) return null
  seen.add(data.id)
  if (seen.size > 4) throw new Error('diagnostic_request_limit')
  if (data.targetVersion === app.getVersion() && data.fromVersion !== data.targetVersion) return null
  if (data.fromVersion !== app.getVersion() || data.targetVersion === data.fromVersion) throw new Error('diagnostic_version_mismatch')
  const manifest = resolve(data.manifest)
  const within = relative(join(activeRoot, 'feeds'), manifest)
  if (!isAbsolute(data.manifest) || within.startsWith('..') || isAbsolute(within) || realpathSync(manifest) !== manifest) throw new Error('diagnostic_manifest_outside_root')
  privateFile(manifest)
  return { id: data.id, manifest, fromVersion: data.fromVersion, targetVersion: data.targetVersion }
}
export function diagnosticManifestSelection(): string | null {
  if (!activeRoot) return null
  if (!pending || claimed) throw new Error('diagnostic_selection_not_requested')
  claimed = true
  return pending.manifest
}
export function confirmDiagnosticSelection(version: string): boolean {
  if (!activeRoot) return false
  if (!pending || !claimed || version !== pending.targetVersion) throw new Error('diagnostic_candidate_version_mismatch')
  response({ id: pending.id, phase: 'selected', fromVersion: pending.fromVersion, targetVersion: version })
  pending = null
  return true
}
export function startDiagnosticUpdateSelection(): void {
  const configured = process.env.ORCA_DIAGNOSTIC_UPDATE_ROOT
  if (!configured) return
  if (process.platform !== 'darwin' || !app.isPackaged || process.env.CI !== 'true' ||
      process.env.ORCA_BACKGROUND_LAUNCH !== '1' || process.env.ORCA_ISOLATED_CI_USER !== '1' ||
      !/^[a-f0-9]{64}$/.test(process.env.ORCA_DIAGNOSTIC_UPDATE_SECRET ?? '')) throw new Error('diagnostic_update_guard_failed')
  activeRoot = realpathSync(configured)
  if (activeRoot !== resolve(configured)) throw new Error('diagnostic_root_not_canonical')
  privateFile(activeRoot, true)
  activeSecret = process.env.ORCA_DIAGNOSTIC_UPDATE_SECRET ?? null
  let stopped = false
  const timer = setInterval(() => {
    if (stopped || pending || !app.isReady() || !getRemoteServerUpdateSupport().automatic) return
    try {
      const state = getUpdateStatus().state
      if (state === 'checking' || state === 'downloading') return
      const selection = readSelection()
      if (!selection) return
      pending = selection
      claimed = false
      checkForUpdatesFromMenu({ localBuild: true })
    } catch {
      stopped = true
      response({ phase: 'refused', code: 'diagnostic_selection_refused' })
    }
  }, 250)
  timer.unref()
  app.once('will-quit', () => clearInterval(timer))
}
