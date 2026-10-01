import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSystemCodexHomePath, resolveOrcaManagedCodexHomePath } from '../codex/codex-home-paths'
import { writeFileAtomicallyIfUnchanged } from './fs-utils'
import { carryRetiredMirrorConfig, RETIRED_MIRROR_CARRY_MARKER } from './retired-mirror-carry'
import { CodexRuntimeHomeAuthSync } from './runtime-home-service-auth-sync'

export abstract class CodexRuntimeHomeMirrorRetirement extends CodexRuntimeHomeAuthSync {
  // Why once, win32 only: Windows retires its mirror now; macOS and Linux left
  // it in #9501, and carrying it today would resurrect long-stale state.
  protected carryRetiredWindowsMirror(): void {
    const markerPath = join(this.getRuntimeMetadataDir(), RETIRED_MIRROR_CARRY_MARKER)
    if (process.platform !== 'win32' || existsSync(markerPath)) {
      return
    }
    try {
      this.carryRetiredMirrorCredentials()
      const configCarried = carryRetiredMirrorConfig({
        runtimeHomePath: resolveOrcaManagedCodexHomePath(),
        systemHomePath: getSystemCodexHomePath()
      })
      if (configCarried) {
        writeFileSync(markerPath, `${JSON.stringify({ carriedAt: Date.now() })}\n`, 'utf-8')
      }
    } catch (error) {
      // Why: a best-effort migration must never fail the launch; the next one retries.
      console.warn('[codex-runtime-home] Failed to carry the retired mirror into ~/.codex:', error)
    }
  }

  // Why: a login, token refresh or MCP OAuth token made inside an Orca pane
  // lives only in the retiring mirror.
  private carryRetiredMirrorCredentials(): void {
    const provenance = this.resolveSharedRuntimeAuthProvenanceStatus()
    // Why committed only: unattributed mirror bytes may be a managed account's.
    if (provenance.kind !== 'committed' || provenance.provenance.owner !== 'system-default') {
      return
    }
    const systemHomePath = getSystemCodexHomePath()
    mkdirSync(systemHomePath, { recursive: true, mode: 0o700 })
    const mirrorCredentials = join(this.getRuntimeHomePath(), '.credentials.json')
    if (existsSync(mirrorCredentials)) {
      const contents = readFileSync(mirrorCredentials, 'utf-8')
      writeFileAtomicallyIfUnchanged(join(systemHomePath, '.credentials.json'), null, contents, {
        mode: 0o600
      })
    }
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
      return
    }
    const systemAuthPath = join(systemHomePath, 'auth.json')
    if (writeFileAtomicallyIfUnchanged(systemAuthPath, seededAuth, runtimeAuth, { mode: 0o600 })) {
      this.captureSystemDefaultSnapshot({ force: true })
      // Why: retained mirror panes and ~/.codex now share one refresh token (#5370).
      this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: runtimeAuth })
    }
  }
}
