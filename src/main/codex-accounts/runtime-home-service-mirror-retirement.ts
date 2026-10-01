import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSystemCodexHomePath, resolveOrcaManagedCodexHomePath } from '../codex/codex-home-paths'
import { writeFileAtomicallyIfUnchanged } from './fs-utils'
import { isLegacySharedMcpCredentialsClaimedByManagedAccount } from './legacy-shared-auth-migration'
import { carryRetiredMirror, RETIRED_MIRROR_CARRY_MARKER } from './retired-mirror-carry'
import { CodexRuntimeHomeAuthSync } from './runtime-home-service-auth-sync'

export abstract class CodexRuntimeHomeMirrorRetirement extends CodexRuntimeHomeAuthSync {
  // Why win32 only: Windows retires its mirror now; macOS and Linux left it in
  // #9501, and carrying it today would resurrect long-stale state.
  protected carryRetiredWindowsMirror(): boolean {
    if (process.platform !== 'win32') {
      return true
    }
    try {
      return carryRetiredMirror(
        {
          runtimeHomePath: resolveOrcaManagedCodexHomePath(),
          systemHomePath: getSystemCodexHomePath()
        },
        join(this.getRuntimeMetadataDir(), RETIRED_MIRROR_CARRY_MARKER),
        () => this.carryRetiredMirrorCredentials()
      )
    } catch (error) {
      // Why: a best-effort migration must never fail the launch; the next one retries.
      console.warn('[codex-runtime-home] Failed to carry the retired mirror into ~/.codex:', error)
      return false
    }
  }

  // Why: a login, token refresh or MCP OAuth token made inside an Orca pane
  // lives only in the retiring mirror. False only when ~/.codex moved mid-merge.
  private carryRetiredMirrorCredentials(): boolean {
    const provenance = this.resolveSharedRuntimeAuthProvenanceStatus()
    // Why committed only: unattributed mirror bytes may be a managed account's.
    if (provenance.kind !== 'committed' || provenance.provenance.owner !== 'system-default') {
      return true
    }
    const systemHomePath = getSystemCodexHomePath()
    const credentialsMerged =
      isLegacySharedMcpCredentialsClaimedByManagedAccount(this.getRuntimeMetadataDir()) ||
      mergeMissingCredentials(
        join(this.getRuntimeHomePath(), '.credentials.json'),
        join(systemHomePath, '.credentials.json')
      )
    const seededAuth = provenance.provenance.authJson
    const runtimeAuthPath = this.getRuntimeAuthPath()
    const runtimeAuth = existsSync(runtimeAuthPath) ? readFileSync(runtimeAuthPath, 'utf-8') : null
    if (
      runtimeAuth === null ||
      runtimeAuth === seededAuth ||
      // Why: anything ~/.codex gained or lost since seeding the mirror is newer.
      this.readSystemDefaultAuth() !== seededAuth ||
      // Why: every mirror launch replaced another account's login with ~/.codex's.
      (seededAuth !== null &&
        !this.runtimeAuthMatchesSystemDefaultIdentity(runtimeAuth, seededAuth))
    ) {
      return credentialsMerged
    }
    const systemAuthPath = join(systemHomePath, 'auth.json')
    // Why a refused write is still done: ~/.codex gained a newer login meanwhile.
    if (writeFileAtomicallyIfUnchanged(systemAuthPath, seededAuth, runtimeAuth, { mode: 0o600 })) {
      this.captureSystemDefaultSnapshot({ force: true })
      // Why: retained mirror panes and ~/.codex now share one refresh token (#5370).
      this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: runtimeAuth })
    }
    return credentialsMerged
  }
}

/**
 * Adds the MCP OAuth entries ~/.codex lacks; Codex keys its fallback store per
 * server. Leaves a store it can't read as a JSON object alone. False when
 * ~/.codex changed underneath, so the carry retries.
 */
function mergeMissingCredentials(mirrorPath: string, systemPath: string): boolean {
  if (!existsSync(mirrorPath)) {
    return true
  }
  const mirror = readFileSync(mirrorPath, 'utf-8')
  const system = existsSync(systemPath) ? readFileSync(systemPath, 'utf-8') : null
  let next = mirror
  if (system !== null) {
    const systemEntries = parseJsonObject(system)
    const missing = Object.entries(parseJsonObject(mirror) ?? {}).filter(
      ([key]) => systemEntries !== null && !Object.hasOwn(systemEntries, key)
    )
    if (systemEntries === null || missing.length === 0) {
      return true
    }
    next = JSON.stringify({ ...systemEntries, ...Object.fromEntries(missing) })
  }
  return writeFileAtomicallyIfUnchanged(systemPath, system, next, { mode: 0o600 })
}

function parseJsonObject(contents: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(contents)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : null
  } catch {
    return null
  }
}
