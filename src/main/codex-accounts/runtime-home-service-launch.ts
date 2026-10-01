import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveHostCodexSessionSourceHome } from '../codex/codex-session-source-home'
import { startSystemCodexSessionBridgeInBackground } from '../codex/codex-session-bridge'
import {
  getSystemCodexHomePath,
  resolveOrcaManagedCodexHomePath,
  syncSystemCodexResourcesIntoManagedHome
} from '../codex/codex-home-paths'
import { syncSystemConfigIntoManagedCodexHome } from '../codex/codex-config-mirror'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import {
  normalizeCodexRuntimeSelection,
  type CodexAccountSelectionTarget
} from './runtime-selection'
import { hasCustomCodexHomeOverrideForLaunch } from '../codex/codex-real-home-path'
import { markCodexSessionBackfillMarkerPending } from '../codex/codex-session-backfill-marker'
import { getCodexSessionBackfillDate } from '../codex/codex-session-backfill-scan-dates'
import { resolveCodexSessionBackfillPaths } from '../codex/codex-session-backfill'
import type { CodexSessionBackfillDate } from '../codex/codex-session-backfill-types'
import { ManagedCodexHomeTemporarilyUnavailableError } from './host-codex-managed-home-ownership'
import { CodexRuntimeHomeRouting } from './runtime-home-service-home-routing'
import { hasRecordedLegacySharedCodexPane } from '../codex/codex-pane-account-registry'
import { syncLegacySharedCodexConfigForRetainedPanes } from './legacy-shared-config-compatibility'
import { carryRetiredMirrorSettings, RETIRED_MIRROR_CARRY_MARKER } from './retired-mirror-carry'
import { writeFileAtomicallyIfUnchanged } from './fs-utils'

export abstract class CodexRuntimeHomeLaunch extends CodexRuntimeHomeRouting {
  protected initializeLastSyncedState(): void {
    const settings = this.store.getSettings()
    const activeAccount = this.getActiveAccount(
      settings.codexManagedAccounts,
      normalizeCodexRuntimeSelection(settings).host
    )
    // Why: WSL-managed homes never touch host ~/.codex; treating one as "last synced" makes cold start mangle host auth Orca never touched.
    this.lastSyncedAccountId = this.getWslManagedHomePath(activeAccount)
      ? null
      : normalizeCodexRuntimeSelection(settings).host
  }

  /**
   * Materializes the runtime home needed before launching the CLI.
   *
   * Historical session bridging is requested in the background so launch setup
   * returns as soon as the active runtime home is ready.
   */
  prepareForCodexLaunch(
    target?: CodexAccountSelectionTarget,
    launchEnv?: NodeJS.ProcessEnv,
    options?: { unavailableManagedHomePath?: string }
  ): string | null {
    if (target?.runtime === 'wsl') {
      const wslTarget = this.resolveWslDefaultTarget(target)
      const homePath = this.getWslCodexHomePathForSelection(wslTarget)
      this.startLegacyWslAuthDrain(wslTarget)
      this.finishWslLaunchPreparation(wslTarget, homePath)
      return homePath
    }
    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    if (selfContainedAccount) {
      const perAccountHome = this.prepareSelfContainedManagedHomeForLaunch(
        selfContainedAccount,
        options?.unavailableManagedHomePath
      )
      if (perAccountHome) {
        return perAccountHome
      }
      // Why: only an untrusted home clears the selection; fall through to the
      // system default without injecting a path Orca cannot prove it owns.
    }
    if (this.isHostSystemDefaultRealHome(launchEnv)) {
      // Why: the system default runs Codex on the user's own ~/.codex.
      // Returning null tells the PTY/env layer to inject no managed CODEX_HOME;
      // the retired mirror is refreshed only for pre-rollout PTYs.
      this.reconcileLegacySharedHomeForRetainedPanes()
      return null
    }
    this.invalidateBackfillAfterManagedSystemDefaultLaunch(launchEnv)
    this.rearmRetiredMirrorCarry()
    this.syncForCurrentSelection(target, launchEnv)
    syncSystemCodexResourcesIntoManagedHome()
    syncSystemConfigIntoManagedCodexHome()
    // Why: sessions can be large; bridge them after launch so starting a fresh TUI never waits on a full tree walk.
    void startSystemCodexSessionBridgeInBackground(
      {},
      resolveHostCodexSessionSourceHome(this.store.getSettings())
    )
    return this.getRuntimeHomePath()
  }

  /**
   * The CODEX_HOME `prepareForCodexLaunch` would pin for a host launch right
   * now, resolved with no side effects: no home/auth sync, no session bridge,
   * no backfill bookkeeping, no hook state, and never a cleared selection.
   * Record-less model catalog reads key on it — a picker open is a read and
   * must not change account state. Same null contract as prepare: null means
   * the system-default real ~/.codex.
   */
  resolveHostCodexHomePathForLaunchReadOnly(launchEnv?: NodeJS.ProcessEnv): string | null {
    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    if (selfContainedAccount) {
      const resolved = this.resolveSelfContainedManagedHome(selfContainedAccount)
      if (resolved.kind === 'owned') {
        return resolved.homePath
      }
      if (resolved.kind === 'indeterminate') {
        // Why: launch prep refuses here too — an unreadable home must not key
        // a read under the system default while the UI shows this account.
        throw new ManagedCodexHomeTemporarilyUnavailableError()
      }
      // Why: launch prep deselects an UNTRUSTED home before routing onward, so
      // its next check sees no selection; predict that route, clearing nothing.
      return this.wouldSystemDefaultRouteToRealHome(launchEnv)
        ? null
        : resolveOrcaManagedCodexHomePath()
    }
    // Why the path-only resolver: getRuntimeHomePath() mkdirs the mirror, and
    // this lookup must not create directories either.
    return this.isHostSystemDefaultRealHome(launchEnv) ? null : resolveOrcaManagedCodexHomePath()
  }

  async prepareForCodexLaunchAsync(
    target?: CodexAccountSelectionTarget,
    launchEnv?: NodeJS.ProcessEnv,
    options?: { unavailableManagedHomePath?: string }
  ): Promise<string | null> {
    if (target?.runtime !== 'wsl') {
      return this.prepareForCodexLaunch(target, launchEnv, options)
    }
    const wslTarget = this.resolveWslDefaultTarget(target)
    const homePath = this.getWslCodexHomePathForSelection(wslTarget)
    // Why: the retired home may hold the freshest credential, so the first
    // direct-home Codex spawn must wait for its bounded guest transaction.
    await this.startLegacyWslAuthDrain(wslTarget, { throwOnFailure: true })
    this.finishWslLaunchPreparation(wslTarget, homePath)
    return homePath
  }

  reconcileLegacySharedHomeForRetainedPanes(): void {
    if (!this.isHostSystemDefaultRealHome()) {
      return
    }
    this.carryRetiredSystemDefaultMirror()
    if (!hasRecordedLegacySharedCodexPane()) {
      return
    }
    this.syncLegacySharedSystemDefaultAuthForRetainedPanes()
    syncLegacySharedCodexConfigForRetainedPanes()
  }

  // Why win32 only: Windows is the lane retiring now. macOS and Linux left the
  // mirror in #9501; carrying it today would resurrect long-stale state.
  private getRetiredMirrorCarryMarkerPath(): string | null {
    return process.platform === 'win32'
      ? join(this.getRuntimeMetadataDir(), RETIRED_MIRROR_CARRY_MARKER)
      : null
  }

  // Why: a system-default launch can still land on the mirror (custom home, or
  // while the first hook approval runs); what it writes there must carry too.
  protected rearmRetiredMirrorCarry(): void {
    const markerPath = this.getRetiredMirrorCarryMarkerPath()
    if (markerPath) {
      rmSync(markerPath, { force: true })
    }
  }

  private carryRetiredSystemDefaultMirror(): void {
    const markerPath = this.getRetiredMirrorCarryMarkerPath()
    if (!markerPath || existsSync(markerPath)) {
      return
    }
    try {
      const provenance = this.resolveSharedRuntimeAuthProvenanceStatus()
      // Why committed only: unattributed mirror bytes may be a managed account's.
      const systemDefaultAuthJson =
        provenance.kind === 'committed' && provenance.provenance.owner === 'system-default'
          ? { mirrored: provenance.provenance.authJson }
          : null
      const settingsCarried = carryRetiredMirrorSettings(
        {
          runtimeHomePath: resolveOrcaManagedCodexHomePath(),
          systemHomePath: getSystemCodexHomePath()
        },
        { mirrorOwnedBySystemDefault: systemDefaultAuthJson !== null }
      )
      if (systemDefaultAuthJson) {
        this.carryRetiredMirrorLogin(systemDefaultAuthJson.mirrored)
      }
      if (settingsCarried) {
        writeFileSync(markerPath, `${JSON.stringify({ carriedAt: Date.now() })}\n`, 'utf-8')
      }
    } catch (error) {
      // Why: a best-effort migration must never fail the launch; the next one retries.
      console.warn('[codex-runtime-home] Failed to carry the retired mirror into ~/.codex:', error)
    }
  }

  // Why: a login done inside an Orca pane lives only in the mirror. Bytes the
  // mirror copied from ~/.codex are not one: their absence there is a logout.
  private carryRetiredMirrorLogin(mirroredAuthJson: string | null): void {
    const runtimeAuthPath = this.getRuntimeAuthPath()
    if (!existsSync(runtimeAuthPath)) {
      return
    }
    const runtimeAuth = readFileSync(runtimeAuthPath, 'utf-8')
    if (
      mirroredAuthJson !== null &&
      this.runtimeAuthMatchesSystemDefaultIdentity(runtimeAuth, mirroredAuthJson)
    ) {
      return
    }
    const systemAuthPath = join(getSystemCodexHomePath(), 'auth.json')
    // Why no overwrite: a login Codex wrote to ~/.codex meanwhile is newer.
    if (!writeFileAtomicallyIfUnchanged(systemAuthPath, null, runtimeAuth, { mode: 0o600 })) {
      return
    }
    this.captureSystemDefaultSnapshot({ force: true })
    // Why: retained mirror panes and ~/.codex now share one refresh token;
    // this baseline lets the legacy-pane sync keep them in step (#5370).
    this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: runtimeAuth })
  }

  beginHostSystemDefaultSessionMigrationLaunch(
    codexHomePath: string | null,
    options: { reattached?: boolean; launchEnv?: NodeJS.ProcessEnv } = {}
  ): boolean | null {
    if (
      !this.isHostSystemDefaultSessionMigrationEligible() ||
      (!codexHomePath && !options.reattached) ||
      (codexHomePath &&
        normalizeRuntimePathForComparison(codexHomePath) !==
          normalizeRuntimePathForComparison(this.getRuntimeHomePath()))
    ) {
      return null
    }
    // Why: an older pass can clear launch preparation while PTY spawn awaits recovery.
    return this.invalidateBackfillAfterManagedSystemDefaultLaunch(
      options.reattached && !codexHomePath ? undefined : options.launchEnv
    )
  }

  isHostSystemDefaultSessionMigrationEligible(): boolean {
    return (
      normalizeCodexRuntimeSelection(this.store.getSettings()).host === null &&
      !hasCustomCodexHomeOverrideForLaunch()
    )
  }

  prepareHostSystemDefaultSessionMigrationPass(
    scanDates: readonly CodexSessionBackfillDate[] = []
  ): boolean {
    const paths = resolveCodexSessionBackfillPaths(
      resolveHostCodexSessionSourceHome(this.store.getSettings())
    )
    const target = normalizeRuntimePathForComparison(paths.systemSessionsRoot)
    if (
      this.hostSystemDefaultSessionMigrationPending &&
      this.pendingHostSystemDefaultSessionMigrationTarget !== target
    ) {
      this.pendingHostSystemDefaultSessionMigrationNeedsFullScan = true
      this.pendingHostSystemDefaultSessionMigrationTarget = target
    }
    // Why: the launch creates rollouts for these dates; record them durably so a
    // force-quit recovers a bounded window instead of re-walking all history.
    const markerOwesFullScan = markCodexSessionBackfillMarkerPending(
      paths.markerPath,
      paths.systemSessionsRoot,
      scanDates.length > 0 ? scanDates : [getCodexSessionBackfillDate()]
    )
    // Why: the marker is the only place an overflowed pending window survives a
    // restart, so its demand has to reach this pass rather than die in the file.
    this.pendingHostSystemDefaultSessionMigrationNeedsFullScan ||= markerOwesFullScan
    return this.pendingHostSystemDefaultSessionMigrationNeedsFullScan
  }

  finishHostSystemDefaultSessionMigrationPass(): void {
    this.hostSystemDefaultSessionMigrationPending = false
    this.pendingHostSystemDefaultSessionMigrationNeedsFullScan = false
    this.pendingHostSystemDefaultSessionMigrationTarget = null
  }
}
