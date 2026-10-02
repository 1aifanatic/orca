import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSystemCodexHomePath, resolveOrcaManagedCodexHomePath } from '../codex/codex-home-paths'
import { writeFileAtomicallyIfUnchanged } from './fs-utils'
import { isLegacySharedMcpCredentialsClaimedByManagedAccount } from './legacy-shared-auth-migration'
import { carryRetiredMirror, RETIRED_MIRROR_CARRY_MARKER } from './retired-mirror-carry'
import { copyFileIfAbsent } from './retired-mirror-home-files'
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
  // lives only in the retiring mirror. Never overwrites anything in ~/.codex.
  private carryRetiredMirrorCredentials(): boolean {
    const provenance = this.resolveSharedRuntimeAuthProvenanceStatus()
    // Why committed only: unattributed mirror bytes may be a managed account's.
    if (provenance.kind !== 'committed' || provenance.provenance.owner !== 'system-default') {
      return true
    }
    const systemHomePath = getSystemCodexHomePath()
    const seededAuth = provenance.provenance.authJson
    const systemAuth = this.readSystemDefaultAuth()
    const runtimeAuthPath = this.getRuntimeAuthPath()
    const runtimeAuth = existsSync(runtimeAuthPath) ? readFileSync(runtimeAuthPath, 'utf-8') : null
    // Why: MCP tokens carry no account of their own, so they follow only into a
    // ~/.codex logged into the account the mirror's panes use, or into none yet.
    const mirrorAccountAuth = runtimeAuth ?? seededAuth
    const sameAccount =
      systemAuth === null ||
      (mirrorAccountAuth !== null &&
        this.runtimeAuthMatchesSystemDefaultIdentity(systemAuth, mirrorAccountAuth))
    if (
      sameAccount &&
      !isLegacySharedMcpCredentialsClaimedByManagedAccount(this.getRuntimeMetadataDir())
    ) {
      copyFileIfAbsent(
        join(this.getRuntimeHomePath(), '.credentials.json'),
        join(systemHomePath, '.credentials.json')
      )
    }
    if (
      runtimeAuth === null ||
      runtimeAuth === seededAuth ||
      // Why: anything ~/.codex gained or lost since seeding the mirror is newer.
      systemAuth !== seededAuth ||
      // Why: every mirror launch replaced another account's login with ~/.codex's.
      (seededAuth !== null &&
        !this.runtimeAuthMatchesSystemDefaultIdentity(runtimeAuth, seededAuth))
    ) {
      return true
    }
    const systemAuthPath = join(systemHomePath, 'auth.json')
    // Why a refused write is still done: ~/.codex gained a newer login meanwhile.
    if (writeFileAtomicallyIfUnchanged(systemAuthPath, seededAuth, runtimeAuth, { mode: 0o600 })) {
      this.captureSystemDefaultSnapshot({ force: true })
      // Why: retained mirror panes and ~/.codex now share one refresh token (#5370).
      this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: runtimeAuth })
    }
    return true
  }
}
