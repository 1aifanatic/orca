import { statSync } from 'node:fs'
import {
  createManagedCommandMatcher,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  readHooksJsonWithRaw,
  removeManagedCommands,
  writeManagedScript,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import {
  assertHooksJsonGeneration,
  backupRealHomeHooksJsonOnce,
  getRealHomeConfigTomlPath,
  getRealHomeHooksJsonPath,
  restoreRealHomeHooksJson,
  writeRealHomeHooksJson
} from './codex-real-home-hooks-json'
import { getCodexManagedScriptFileName } from './codex-hook-identity'
import {
  CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS,
  grantManagedCodexHookTrust,
  type CodexTrustGrantFallbackReason
} from './codex-hook-trust-grant'
import {
  isRealHomeCodexHookCurrent,
  planRealHomeCodexHookInstall,
  realHomeGrantPlan
} from './codex-real-home-hook-plan'
import {
  readCodexTrustGrantLedgerHomeForReconciliation,
  removeCodexManagedHookTrustEntries
} from './codex-managed-trust-reconciliation'
import { removeSystemManagedHookTrustEntries } from './codex-hook-trust-cleanup'
import { getCodexManagedHookInstallMaterial } from './codex-hook-definition'
import { getSystemCodexHomePath } from './codex-home-paths'
import { restoreCodexTrustConfig } from './codex-trust-config-rollback'
import { mutateRealHomeHooksPreservingUserTrust } from './codex-user-hook-trust-rebase'
import { runExclusivelyForSystemTrustConfig, withRealHomeWriteLock } from './codex-hook-trust-queue'

/**
 * Real-home Codex hook lane for the system-default selection (flag ON).
 *
 * - 'pending': no attempt yet this process; routing may optimistically use the
 *   real home (reads are hook-free and the install runs before pane spawns).
 * - 'installed': entry appended LAST in ~/.codex/hooks.json and trusted by
 *   codex itself through the app-server grant client.
 * - 'unavailable': the grant lane could not trust the entry (old binary,
 *   unsupported RPC, verify failure). The entry is rolled back and the host
 *   stays on the managed-home lane.
 * - 'removed': hooks are off here. Launch prep leaves the real home as it is;
 *   only an explicit opt-out strips Orca's entry, since other Orcas share it.
 */
export type RealHomeCodexHookLane = 'pending' | 'installed' | 'unavailable' | 'removed'

let currentLane: RealHomeCodexHookLane = 'pending'
let installRetryAfterMs = 0
let ensureInFlight: Promise<RealHomeCodexHookLane> = Promise.resolve(currentLane)

export function getRealHomeCodexHookLane(): RealHomeCodexHookLane {
  return currentLane
}

/**
 * Routing gate consumed by CodexRuntimeHomeService. Both a failed install and
 * a failed opt-out cleanup use the managed lane so no half-mutated hook state
 * can diverge from PTY, rate-limit, or commit-message routing.
 */
export function isRealHomeCodexHookLaneUsable(): boolean {
  return currentLane !== 'unavailable'
}

/**
 * Installs and trusts the Orca status hook in the real home when hooks are on,
 * and writes nothing when they are off. Idempotent;
 * repeat calls are cheap — an unchanged hooks.json write no-ops and a valid
 * grant ledger skips the RPC session entirely.
 * Never throws: any failure logs and leaves the host on the managed lane.
 */
export function ensureRealHomeCodexHookState(args: {
  hooksEnabled: boolean
  userDataPath: string
}): Promise<RealHomeCodexHookLane> {
  // Why: the grant client caches failed probes, but mutating and rolling back
  // hooks.json before consulting it still adds work to every pane launch.
  if (args.hooksEnabled && currentLane === 'unavailable' && Date.now() < installRetryAfterMs) {
    return Promise.resolve(currentLane)
  }
  // Why: this mutates the user's real ~/.codex and the module's lane state.
  // Concurrent pane launches must not interleave two of them, and the shared
  // config.toml lane keeps the rebase + grant pair atomic against the managed
  // installer's legacy sweep of the same file.
  const run = (): Promise<RealHomeCodexHookLane> => runRealHomeCodexHookEnsure(args)
  // Why both handlers: a rejected predecessor must not poison every later
  // ensure for the process' lifetime.
  ensureInFlight = ensureInFlight.then(run, run)
  return ensureInFlight
}

async function runRealHomeCodexHookEnsure(args: {
  hooksEnabled: boolean
  userDataPath: string
}): Promise<RealHomeCodexHookLane> {
  if (!args.hooksEnabled) {
    // Why: this runs for launch prep and startup, and the entry is shared by
    // every Orca on this HOME; removing it is the explicit opt-out's job.
    currentLane = 'removed'
    installRetryAfterMs = 0
    return currentLane
  }
  try {
    // Why inside the try: resolving the real home can throw too, and this
    // function is the module's "never throws" boundary.
    currentLane = await runExclusivelyForSystemTrustConfig(() =>
      ensureRealHomeCodexHookInstalled(args.userDataPath)
    )
    if (currentLane === 'installed') {
      installRetryAfterMs = 0
    }
  } catch (error) {
    console.warn('[codex-real-home-hooks] ensure failed; staying on managed lane:', error)
    currentLane = 'unavailable'
    installRetryAfterMs = Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
  }
  return currentLane
}

async function ensureRealHomeCodexHookInstalled(
  userDataPath: string
): Promise<RealHomeCodexHookLane> {
  const plan = planRealHomeCodexHookInstall()
  if (!plan) {
    installRetryAfterMs = Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
    return 'unavailable'
  }
  // Why compare first: every pane spawn on this lane lands here, and the steady
  // state writes nothing, so it must not wait behind another instance's session.
  if (await isRealHomeCodexHookCurrent(plan)) {
    return 'installed'
  }
  return await withRealHomeWriteLock(() => installRealHomeCodexHook(userDataPath))
}

/** Must hold the real-home write lock: re-reads, so a change made while waiting is honoured. */
async function installRealHomeCodexHook(userDataPath: string): Promise<RealHomeCodexHookLane> {
  const plan = planRealHomeCodexHookInstall()
  if (!plan) {
    installRetryAfterMs = Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
    return 'unavailable'
  }
  const { material, hooksJsonPath, previousRaw, config, nextHooks } = plan
  const hooksWritePath = resolveHooksJsonWritePath(hooksJsonPath)

  // Why: the same script the managed lane maintains; deploying here too keeps
  // host-connect ordering independent of the managed installer loop.
  writeManagedScript(material.scriptPath, material.script)

  const previousMode = previousRaw === null ? undefined : statSync(hooksWritePath).mode
  backupRealHomeHooksJsonOnce(userDataPath, previousRaw)
  let writtenRaw: string | null = null
  // Why: unknown top-level fields belong to the user (other managers'
  // metadata); unlike the managed-home writer, preserve them verbatim.
  const trustRebase = await mutateRealHomeHooksPreservingUserTrust({
    sourcePath: hooksJsonPath,
    runtimeHomePath: getSystemCodexHomePath(),
    tomlPath: getRealHomeConfigTomlPath(),
    beforeHooks: config.hooks ?? {},
    afterHooks: nextHooks,
    writeHooks: () => {
      assertHooksJsonGeneration(hooksJsonPath, hooksWritePath, previousRaw)
      writtenRaw = writeRealHomeHooksJson(hooksWritePath, { ...config, hooks: nextHooks })
    },
    restoreHooks: () =>
      restoreRealHomeHooksJson(hooksWritePath, previousRaw, writtenRaw, previousMode)
  })

  const grant = await grantManagedCodexHookTrust(realHomeGrantPlan(plan))
  if (grant.lane === 'rpc') {
    return 'installed'
  }

  // Why: never leave an untrusted Orca entry in the user's real home — it
  // would surface as "Hooks need review". Roll the file back to its prior
  // bytes and keep this host on the managed-home lane; the grant client
  // already logged the fallback reason.
  try {
    restoreRealHomeHooksJson(hooksWritePath, previousRaw, writtenRaw, previousMode)
  } finally {
    // Why: a user-trust rebase may have succeeded before the managed grant
    // failed. Roll both files back to the same pre-mutation generation.
    if (trustRebase) {
      restoreCodexTrustConfig(
        getRealHomeConfigTomlPath(),
        trustRebase.snapshot,
        trustRebase.written
      )
    }
  }
  installRetryAfterMs = getInstallRetryAfterMs(grant.reason)
  console.warn(
    `[codex-real-home-hooks] trust grant unavailable (${grant.reason}); entry rolled back, managed lane kept`
  )
  return 'unavailable'
}

function getInstallRetryAfterMs(reason: CodexTrustGrantFallbackReason): number {
  return reason === 'unsupported' || reason === 'unsupported-cached' || reason === 'disabled'
    ? Number.POSITIVE_INFINITY
    : Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
}

async function sweepRealHomeCodexHook(): Promise<RealHomeCodexHookLane> {
  const hooksJsonPath = getRealHomeHooksJsonPath()
  // Why: single read — the pre-write generation guard must compare against
  // the exact bytes this sweep's parse came from.
  const { raw: previousRaw, config } = readHooksJsonWithRaw(hooksJsonPath)
  if (!config) {
    // Why: a failed or malformed read proves no cleanup; keep the managed lane
    // until a later pass can inspect and remove the real-home entry.
    return 'unavailable'
  }
  if (!config.hooks || previousRaw === null) {
    return 'removed'
  }
  const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
  const material = getCodexManagedHookInstallMaterial()
  const nextHooks: Record<string, HookDefinition[]> = { ...config.hooks }
  let removedAny = false
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (
      cleaned.length !== definitions.length ||
      cleaned.some((definition, index) => definition !== definitions[index])
    ) {
      removedAny = true
    }
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }
  if (removedAny) {
    const hooksWritePath = resolveHooksJsonWritePath(hooksJsonPath)
    const previousMode = statSync(hooksWritePath).mode
    let writtenRaw: string | null = null
    await mutateRealHomeHooksPreservingUserTrust({
      sourcePath: hooksJsonPath,
      runtimeHomePath: getSystemCodexHomePath(),
      tomlPath: getRealHomeConfigTomlPath(),
      beforeHooks: config.hooks,
      afterHooks: nextHooks,
      writeHooks: () => {
        assertHooksJsonGeneration(hooksJsonPath, hooksWritePath, previousRaw)
        writtenRaw = writeRealHomeHooksJson(hooksWritePath, { ...config, hooks: nextHooks })
      },
      restoreHooks: () =>
        restoreRealHomeHooksJson(hooksWritePath, previousRaw, writtenRaw, previousMode)
    })
    // Why: dead [hooks.state] blocks for a removed hook are Orca-owned records;
    // dropping them keeps the user's config.toml from accumulating orphans.
    // Verify ownership by the expected hash or grant ledger: stale/mixed hook
    // groups must never make Orca delete a user's trust record at the same key.
    try {
      removeCodexManagedHookTrustEntries({
        tomlPath: getRealHomeConfigTomlPath(),
        runtimeHomePath: getSystemCodexHomePath(),
        sourcePath: hooksJsonPath,
        command: material.command,
        managedEventLabels: new Set(Object.values(material.eventLabel)),
        timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
      })
    } catch (error) {
      console.warn('[codex-real-home-hooks] failed to drop Orca trust entries:', error)
    }
  }
  return 'removed'
}

/**
 * The user's explicit opt-out: strips Orca's entry and its trust from the real
 * ~/.codex. Joins the system lane an opt-out caller already holds.
 */
export async function removeRealHomeCodexHookForOptOut(): Promise<RealHomeCodexHookLane> {
  try {
    currentLane = await runExclusivelyForSystemTrustConfig(() =>
      withRealHomeWriteLock(async () => {
        const lane = await sweepRealHomeCodexHook()
        const systemHomePath = getSystemCodexHomePath()
        if (readCodexTrustGrantLedgerHomeForReconciliation(systemHomePath) !== null) {
          // Why: the ledger outlives a sweep that removed the entry but not its trust.
          removeSystemManagedHookTrustEntries(systemHomePath, getRealHomeHooksJsonPath())
        }
        return lane
      })
    )
  } catch (error) {
    console.warn('[codex-real-home-hooks] opt-out cleanup failed; staying on managed lane:', error)
    currentLane = 'unavailable'
  }
  return currentLane
}

export const _internals = {
  setLaneForTesting(lane: RealHomeCodexHookLane): void {
    currentLane = lane
    installRetryAfterMs = 0
    ensureInFlight = Promise.resolve(lane)
  }
}
