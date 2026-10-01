import { win32 as pathWin32 } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { dedupeInFlightRun } from '../in-flight-run-dedupe'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import { writeManagedScript } from '../agent-hooks/installer-utils'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'
import { getManagedScriptPath } from './codex-hook-definition'
import { ensureCodexCmdHookFlagGate } from './codex-cmd-hook-flag-gate'
import { cleanupLegacyManagedHookRepresentations } from './codex-hook-legacy-cleanup'
import { removeRealHomeCodexHookEntries } from './codex-real-home-hook-install'
import {
  getCodexHookSessionFlagFailure,
  getDefaultCodexHookFlagVersion,
  refreshCodexHookSessionFlags
} from './codex-hook-session-trust'
import { reconcileCodexHookFlagTable } from './codex-hook-flag-requests'
import { listCodexHookFlagEntries } from './codex-hook-flag-table'
import {
  refreshCodexRuntimeUserHooksExclusively,
  removeCodexHooksExclusively
} from './codex-hook-local-maintenance'
import { installCodexHooksRemote } from './codex-hook-remote-install'
import { getManagedScript } from './codex-hook-script'
import { removeStaleWslRuntimeManagedHookTrustEntries } from './codex-hook-trust-cleanup'
import { runExclusivelyForRuntimeAndSystemTrustConfig } from './codex-hook-trust-queue'
import {
  getWslHookReconciliationAction,
  getWslReconciliationKey,
  installManagedHooksIntoWslRuntime,
  refreshWslRuntimeUserHooks
} from './codex-hook-wsl-runtime'
import {
  createCodexWslRuntimeHookInstallPlan,
  type CodexWslRuntimeHookTarget,
  type WslCanonicalPathSettlement
} from './codex-wsl-hook-install-plan'

function launchPrepKey(runtimeHomePath: string): string {
  return normalizeRuntimePathForComparison(runtimeHomePath)
}

export class CodexHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getManagedScript())
  }

  private readonly wslReconciliationGeneration = new Map<string, number>()
  private readonly wslInstallsInFlight = new Map<string, Promise<AgentHookInstallStatus | null>>()
  private readonly launchPrepInFlight = new Map<string, Promise<AgentHookInstallStatus>>()

  private supersedeWslReconciliation(runtimeHomePath: string | null | undefined): number {
    if (!runtimeHomePath) {
      return 0
    }
    const key = getWslReconciliationKey(runtimeHomePath)
    const generation = (this.wslReconciliationGeneration.get(key) ?? 0) + 1
    this.wslReconciliationGeneration.set(key, generation)
    return generation
  }

  async installForRuntimeHome(
    runtimeHomePath: string | null | undefined,
    target?: CodexWslRuntimeHookTarget
  ): Promise<AgentHookInstallStatus | null> {
    const generation = this.supersedeWslReconciliation(runtimeHomePath)
    let installedTrustConfigPath: string | null = null
    let installSucceeded = false
    // Why: the install below now awaits a codex app-server session, so a
    // settlement callback can land mid-install. This gate keeps reconciliation
    // reading the finished install's flags, as it did when the install was
    // synchronous and no callback could interleave with it.
    let markPrimaryInstallSettled!: () => void
    let reconciliationChain = new Promise<void>((resolve) => {
      markPrimaryInstallSettled = resolve
    })
    const reconcileSettledWslCanonicalPath = async (
      settlement: WslCanonicalPathSettlement
    ): Promise<void> => {
      if (!runtimeHomePath) {
        return
      }
      const key = getWslReconciliationKey(runtimeHomePath)
      const resolvedPlan =
        settlement.status === 'resolved'
          ? createCodexWslRuntimeHookInstallPlan(
              runtimeHomePath,
              target,
              () => settlement.canonicalPath
            )
          : null
      const action = getWslHookReconciliationAction({
        settlement,
        isCurrentGeneration: this.wslReconciliationGeneration.get(key) === generation,
        installedTrustConfigPath,
        resolvedTrustConfigPath: resolvedPlan?.trustConfigPath ?? null,
        installSucceeded
      })
      if (action === 'none') {
        return
      }
      if (action === 'remove') {
        try {
          removeStaleWslRuntimeManagedHookTrustEntries(
            pathWin32.join(runtimeHomePath, 'config.toml'),
            []
          )
        } catch (error) {
          console.warn('[codex-hook-service] failed to revoke stale WSL hook trust', error)
        }
        return
      }
      if (!resolvedPlan) {
        return
      }
      const status = await installManagedHooksIntoWslRuntime(resolvedPlan)
      if (status.state === 'error') {
        console.warn('[codex-hook-service] failed to reconcile WSL hook path', status.detail)
        return
      }
      installedTrustConfigPath = resolvedPlan.trustConfigPath
      installSucceeded = status.state === 'installed'
    }
    const onCanonicalPathSettled = (settlement: WslCanonicalPathSettlement): void => {
      const run = (): Promise<void> => reconcileSettledWslCanonicalPath(settlement)
      reconciliationChain = reconciliationChain.then(run, run)
      void reconciliationChain.catch((error: unknown) => {
        console.warn('[codex-hook-service] failed to reconcile WSL hook path', error)
      })
    }
    const wslPlan = createCodexWslRuntimeHookInstallPlan(
      runtimeHomePath,
      target,
      undefined,
      onCanonicalPathSettled
    )
    installedTrustConfigPath = wslPlan?.trustConfigPath ?? null
    try {
      const status = wslPlan ? await installManagedHooksIntoWslRuntime(wslPlan) : null
      installSucceeded = status?.state === 'installed'
      return status
    } finally {
      markPrimaryInstallSettled()
    }
  }

  installForRuntimeHomeSerialized(
    runtimeHomePath: string | null | undefined,
    target?: CodexWslRuntimeHookTarget
  ): Promise<AgentHookInstallStatus | null> {
    if (!runtimeHomePath) {
      return Promise.resolve(null)
    }
    const targetKey = target?.runtime === 'wsl' ? target.wslDistro?.trim().toLowerCase() : ''
    return dedupeInFlightRun(
      this.wslInstallsInFlight,
      `${getWslReconciliationKey(runtimeHomePath)}\0${targetKey ?? ''}`,
      () => this.installForRuntimeHome(runtimeHomePath, target)
    )
  }

  async prepareRuntimeHomeForLaunch(
    runtimeHomePath: string | null | undefined,
    target: CodexWslRuntimeHookTarget | undefined,
    hooksEnabled: boolean
  ): Promise<AgentHookInstallStatus> {
    if (hooksEnabled) {
      // Why: a WSL guest still gets Orca's entry installed and approved in its
      // home; a native launch carries it as a session flag, so its home only
      // mirrors the user's own hooks.
      return (
        (await this.installForRuntimeHomeSerialized(runtimeHomePath, target)) ??
        (await this.refreshRuntimeUserHooksForLaunchPrep(runtimeHomePath ?? undefined))
      )
    }
    return (
      this.refreshRuntimeUserHooksForRuntimeHome(runtimeHomePath, target) ??
      (await this.refreshRuntimeUserHooksForLaunchPrep(runtimeHomePath ?? undefined))
    )
  }

  refreshRuntimeUserHooksForRuntimeHome(
    runtimeHomePath: string | null | undefined,
    target?: CodexWslRuntimeHookTarget
  ): AgentHookInstallStatus | null {
    this.supersedeWslReconciliation(runtimeHomePath)
    const wslPlan = createCodexWslRuntimeHookInstallPlan(runtimeHomePath, target)
    return wslPlan ? refreshWslRuntimeUserHooks(wslPlan) : null
  }

  /**
   * Native Codex's status hook is ready when the flag table holds an entry for
   * the codex this process resolves (any entry where that version is unknown,
   * as in the CLI's process). Read from disk.
   */
  getStatus(): AgentHookInstallStatus {
    const current = getDefaultCodexHookFlagVersion()
    const versions = listCodexHookFlagEntries()
      .map((entry) => entry.codexVersion)
      .filter((version) => current === null || version === current)
    return {
      agent: 'codex',
      state: versions.length > 0 ? 'installed' : 'not_installed',
      configPath: getManagedScriptPath(),
      managedHooksPresent: versions.length > 0,
      detail:
        versions.length > 0
          ? `Carried as a session flag for ${versions.join(', ')}`
          : (getCodexHookSessionFlagFailure() ?? 'Codex has not reported its hook trust yet')
    }
  }

  /**
   * The setting turning on, whether or not codex is installed yet: a later
   * launch's miss then asks for its entry instead of running plain codex.
   */
  openSessionFlagTable(): void {
    reconcileCodexHookFlagTable(true)
  }

  /**
   * App start and the setting turning on: publishes the flag for the resolved
   * Codex, deploys the hook script, and removes Orca's entries from ~/.codex
   * and the shared managed home. The only ~/.codex writes are those removals.
   */
  async installSessionFlags(): Promise<AgentHookInstallStatus> {
    // Why started first and awaited last: cleanup below may throw, and must never stop the flag.
    const flags = refreshCodexHookSessionFlags()
    try {
      writeManagedScript(getManagedScriptPath(), getManagedScript())
      ensureCodexCmdHookFlagGate()
      // Why the retired-form sweep first: it finds their trust through the entries
      // it removes, and the removal below strips those entries too.
      await cleanupLegacyManagedHookRepresentations()
      await removeRealHomeCodexHookEntries()
      await this.refreshRuntimeUserHooks()
    } finally {
      await flags
    }
    return this.getStatus()
  }

  /**
   * Launch prep runs on every local PTY spawn, and the refresh below serializes
   * per Codex home, so spawns racing for the same home share one run.
   * `dedupeInFlightRun` drops the run the moment it settles, so the next launch
   * re-reads hooks.json and the user's trust state.
   */
  refreshRuntimeUserHooksForLaunchPrep(runtimeHomePath?: string): Promise<AgentHookInstallStatus> {
    const homePath = runtimeHomePath ?? getOrcaManagedCodexHomePath()
    return dedupeInFlightRun(this.launchPrepInFlight, launchPrepKey(homePath), () =>
      this.refreshRuntimeUserHooks(homePath)
    )
  }

  installRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    options?: { codexHomeDir?: string; deferTrustUntilConfigToml?: boolean }
  ): Promise<AgentHookInstallStatus> {
    return installCodexHooksRemote(sftp, remoteHome, options)
  }

  refreshRuntimeUserHooks(
    runtimeHomePath: string = getOrcaManagedCodexHomePath()
  ): Promise<AgentHookInstallStatus> {
    return runExclusivelyForRuntimeAndSystemTrustConfig(runtimeHomePath, () =>
      this.refreshRuntimeUserHooksExclusively(runtimeHomePath)
    )
  }

  private refreshRuntimeUserHooksExclusively(
    runtimeHomePath: string
  ): Promise<AgentHookInstallStatus> {
    return refreshCodexRuntimeUserHooksExclusively(runtimeHomePath, () => this.getStatus())
  }

  remove(): Promise<AgentHookInstallStatus> {
    // Why outside the trust lane: open panes read the table at their next launch,
    // so this is what stops them, and it never waits behind a launch's refresh.
    reconcileCodexHookFlagTable(false)
    return runExclusivelyForRuntimeAndSystemTrustConfig(getOrcaManagedCodexHomePath(), () =>
      removeCodexHooksExclusively(() => this.getStatus())
    )
  }
}
