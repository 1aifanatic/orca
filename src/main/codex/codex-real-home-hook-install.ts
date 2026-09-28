import {
  createManagedCommandMatcher,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  readHooksJsonWithRaw,
  removeManagedCommands,
  writeHooksJson,
  writeManagedScript,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import {
  assertHooksJsonGeneration,
  backupRealHomeHooksJsonOnce,
  getRealHomeConfigTomlPath,
  getRealHomeHooksJsonPath
} from './codex-real-home-hooks-json'
import { getCodexManagedScriptFileName } from './codex-hook-identity'
import {
  CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS,
  grantManagedCodexHookTrust,
  type CodexManagedTrustGrantOutcome
} from './codex-hook-trust-grant'
import {
  readCodexTrustGrantLedgerHomeForReconciliation,
  removeCodexManagedHookTrustEntries
} from './codex-managed-trust-reconciliation'
import { removeSystemManagedHookTrustEntries } from './codex-hook-trust-cleanup'
import { getCodexManagedHookInstallMaterial } from './codex-hook-definition'
import { getSystemCodexHomePath } from './codex-home-paths'
import { mutateRealHomeHooksPreservingUserTrust } from './codex-user-hook-trust-rebase'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import {
  planRealHomeCodexHookEntries,
  type RealHomeCodexHookWritePolicy
} from './codex-real-home-hook-entry-plan'
import { withdrawUntrustedRealHomeWrites } from './codex-real-home-hook-withdrawal'

export type { RealHomeCodexHookWritePolicy }

/**
 * Real-home Codex hook lane for the system-default selection (flag ON).
 *
 * - 'pending': no attempt yet this process; routing may optimistically use the
 *   real home (reads are hook-free and the install runs before pane spawns).
 * - 'installed': every managed event in ~/.codex/hooks.json has an Orca entry,
 *   and the frozen ones are trusted by codex itself through the app-server grant.
 * - 'unavailable': the grant lane could not trust the entry (old binary,
 *   unsupported RPC, verify failure). An entry this call wrote that is still
 *   untrusted is withdrawn, and the host stays on the managed-home lane.
 * - 'removed': hooks are off here. Launch prep leaves the real home as it is;
 *   only an explicit opt-out strips Orca's entry, since other Orcas share it.
 */
export type RealHomeCodexHookLane = 'pending' | 'installed' | 'unavailable' | 'removed'

let currentLane: RealHomeCodexHookLane = 'pending'
let installRetryAfterMs = 0
let ensureInFlight: Promise<RealHomeCodexHookLane> = Promise.resolve(currentLane)
let queuedEnsure: { key: string; lane: Promise<RealHomeCodexHookLane> } | null = null

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
 * and writes nothing when they are off. Add-only: it never removes an Orca
 * entry, and only `convert-older-forms` rewrites one. Idempotent; a home that
 * already holds the frozen entry costs one read, and a valid grant ledger skips
 * the RPC session. Never throws: any failure logs and leaves the managed lane.
 */
export function ensureRealHomeCodexHookState(args: {
  hooksEnabled: boolean
  userDataPath: string
  writePolicy: RealHomeCodexHookWritePolicy
}): Promise<RealHomeCodexHookLane> {
  // Why: the grant client caches failed probes, but mutating and rolling back
  // hooks.json before consulting it still adds work to every pane launch.
  if (args.hooksEnabled && currentLane === 'unavailable' && Date.now() < installRetryAfterMs) {
    return Promise.resolve(currentLane)
  }
  // Why: this mutates the user's real ~/.codex and the module's lane state.
  // Concurrent pane launches must not interleave two of them, and the shared
  // config.toml lane keeps the write + grant pair ordered against the managed
  // installer's retired-form sweep of the same file.
  const key = `${args.hooksEnabled}:${args.writePolicy}:${args.userDataPath}`
  // Why: launches that queue behind a slow session share one follow-up run, so
  // each waits for at most two sessions, not one per earlier launch.
  if (queuedEnsure?.key === key) {
    return queuedEnsure.lane
  }
  const run = (): Promise<RealHomeCodexHookLane> => {
    if (queuedEnsure?.lane === lane) {
      queuedEnsure = null
    }
    return runRealHomeCodexHookEnsure(args)
  }
  // Why both handlers: a rejected predecessor must not poison every later
  // ensure for the process' lifetime.
  const lane = ensureInFlight.then(run, run)
  queuedEnsure = { key, lane }
  ensureInFlight = lane
  return lane
}

async function runRealHomeCodexHookEnsure(args: {
  hooksEnabled: boolean
  userDataPath: string
  writePolicy: RealHomeCodexHookWritePolicy
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
    currentLane = await runExclusivelyForCodexTrustConfig(getRealHomeConfigTomlPath(), () =>
      installRealHomeCodexHook(args.userDataPath, args.writePolicy)
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

async function installRealHomeCodexHook(
  userDataPath: string,
  writePolicy: RealHomeCodexHookWritePolicy
): Promise<RealHomeCodexHookLane> {
  const material = getCodexManagedHookInstallMaterial()
  const hooksJsonPath = getRealHomeHooksJsonPath()
  const hooksWritePath = resolveHooksJsonWritePath(hooksJsonPath)
  // Why: the pre-write guard compares against these bytes; a separate later
  // read would let a concurrent save land between parse and write.
  const { raw: previousRaw, config } = readHooksJsonWithRaw(hooksJsonPath)
  if (!config) {
    // Why: an unparseable user file must never be clobbered; without a hook
    // entry the managed lane keeps status working for this host.
    console.warn('[codex-real-home-hooks] could not parse', hooksJsonPath, '- managed lane kept')
    installRetryAfterMs = Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
    return 'unavailable'
  }
  if (Object.keys(config).some((key) => key !== 'hooks')) {
    // Why: Codex rejects unknown root keys instead of ignoring them. Avoid a
    // transient rewrite of a user-owned file that the trust RPC cannot load.
    installRetryAfterMs = Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
    return 'unavailable'
  }

  // Why: the same script the managed lane maintains; deploying here too keeps
  // host-connect ordering independent of the managed installer loop.
  writeManagedScript(material.scriptPath, material.script)

  const plan = planRealHomeCodexHookEntries({
    hooks: config.hooks ?? {},
    sourcePath: hooksJsonPath,
    material,
    isOrcaCommand: createManagedCommandMatcher(getCodexManagedScriptFileName()),
    policy: writePolicy
  })
  if (plan.changed) {
    backupRealHomeHooksJsonOnce(userDataPath, previousRaw)
    mutateRealHomeHooksPreservingUserTrust({
      sourcePath: hooksJsonPath,
      tomlPath: getRealHomeConfigTomlPath(),
      beforeHooks: config.hooks ?? {},
      afterHooks: plan.hooks,
      writeHooks: () => {
        assertHooksJsonGeneration(hooksJsonPath, hooksWritePath, previousRaw)
        // Why: unknown top-level fields belong to the user (other managers'
        // metadata); unlike the managed-home writer, preserve them verbatim.
        writeHooksJson(hooksWritePath, { ...config, hooks: plan.hooks }, { preserveMode: true })
      }
    })
  }
  if (plan.managedEntries.length === 0) {
    // Why: every event holds an entry of another form, which its writer keeps trusted.
    return 'installed'
  }

  const grant = await grantManagedCodexHookTrust({
    runtimeHomePath: getSystemCodexHomePath(),
    tomlPath: getRealHomeConfigTomlPath(),
    managedCommand: material.command,
    managedEntries: plan.managedEntries,
    host: { kind: 'native' },
    telemetryLane: 'real-home',
    useDefaultCodexHome: true
  })
  if (grant.lane === 'rpc') {
    return 'installed'
  }

  // Why: an untrusted Orca entry surfaces as "Hooks need review". Withdraw only
  // what this call wrote, and only while it is still untrusted: another Orca
  // may have trusted the identical entry meanwhile, and the grant client
  // already logged the fallback reason.
  withdrawUntrustedRealHomeWrites(plan.writes, material.command)
  installRetryAfterMs = getInstallRetryAfterMs(grant)
  console.warn(
    `[codex-real-home-hooks] trust grant unavailable (${grant.reason}); managed lane kept`
  )
  return 'unavailable'
}

function getInstallRetryAfterMs(
  grant: Extract<CodexManagedTrustGrantOutcome, { lane: 'fallback' }>
): number {
  if (
    grant.reason === 'unsupported' ||
    grant.reason === 'unsupported-cached' ||
    grant.reason === 'disabled'
  ) {
    return Number.POSITIVE_INFINITY
  }
  // Why: a slow cold start retries on the next launch instead of latching for minutes.
  return grant.errorClass === 'timeout'
    ? 0
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
    mutateRealHomeHooksPreservingUserTrust({
      sourcePath: hooksJsonPath,
      tomlPath: getRealHomeConfigTomlPath(),
      beforeHooks: config.hooks,
      afterHooks: nextHooks,
      writeHooks: () => {
        assertHooksJsonGeneration(hooksJsonPath, hooksWritePath, previousRaw)
        writeHooksJson(hooksWritePath, { ...config, hooks: nextHooks }, { preserveMode: true })
      }
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
    currentLane = await runExclusivelyForCodexTrustConfig(getRealHomeConfigTomlPath(), async () => {
      const lane = await sweepRealHomeCodexHook()
      const systemHomePath = getSystemCodexHomePath()
      // Why 'removed' only: an unread or malformed file may still hold the entry,
      // so its trust and the ledger that proves ownership must wait for a later pass.
      if (
        lane === 'removed' &&
        readCodexTrustGrantLedgerHomeForReconciliation(systemHomePath) !== null
      ) {
        // Why: the ledger outlives a sweep that removed the entry but not its trust.
        removeSystemManagedHookTrustEntries(systemHomePath, getRealHomeHooksJsonPath())
      }
      return lane
    })
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
    queuedEnsure = null
  }
}
