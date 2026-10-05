import {
  createManagedCommandMatcher,
  readHooksJsonWithRaw,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import {
  assertHooksJsonGeneration,
  backupRealHomeHooksJsonOnce,
  getRealHomeConfigTomlPath,
  getRealHomeHooksJsonPath
} from './codex-real-home-hooks-json'
import { getCodexManagedScriptFileName } from './codex-hook-identity'
import { readCodexTrustGrantLedgerHomeForReconciliation } from './codex-managed-trust-reconciliation'
import { removeSystemManagedHookTrustEntries } from './codex-hook-trust-cleanup'
import { CODEX_EVENT_LABEL, getCodexManagedHookInstallMaterial } from './codex-hook-definition'
import { getSystemCodexHomePath } from './codex-home-paths'
import { mutateRealHomeHooksPreservingUserTrust } from './codex-user-hook-trust-moves'
import { sweepRealHomeCodexHook } from './codex-real-home-hook-sweep'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import { planRealHomeCodexHookEntries } from './codex-real-home-hook-entry-plan'
import type { CodexHookHashes } from './codex-hook-trust-derivation'
import {
  findMissingCodexHookApprovals,
  writeCodexHookApprovalsBeforeEntries
} from './codex-hook-approval-first-write'
import {
  codexHookSourcePathsEqual,
  computeTrustKey,
  getCodexExplicitHomeHookSourcePath,
  normalizeCodexHookSourcePath,
  normalizeHookTrustKeyForLookup,
  parseTrustKey,
  readHookTrustEntries,
  removeHookTrustEntries,
  type CodexHookTrustState,
  type CodexTrustEntry
} from './config-toml-trust'

/**
 * - 'unchanged': Orca's entries and their approvals were already as wanted; nothing written.
 * - 'written': this call wrote approvals, entries, or both.
 * - 'unavailable': hooks.json is unreadable or not Codex's shape, or a write failed.
 * - 'disabled': hooks were off when the lane came free; nothing written.
 */
export type RealHomeCodexHookOutcome = 'unchanged' | 'written' | 'unavailable' | 'disabled'

export type RealHomeCodexHookReconcile = {
  outcome: RealHomeCodexHookOutcome
  /** Orca's entries with the approval each needs, keyed as Codex keys them. */
  approvals: CodexTrustEntry[]
}

/**
 * The key Codex gives an entry in ~/.codex/hooks.json: an explicit CODEX_HOME
 * is resolved to its real path, the default home is kept as spelled.
 */
export function getRealHomeHookKeySourcePath(): string {
  const hooksJsonPath = getRealHomeHooksJsonPath()
  return process.env.CODEX_HOME?.trim()
    ? getCodexExplicitHomeHookSourcePath(hooksJsonPath)
    : normalizeCodexHookSourcePath(hooksJsonPath)
}

/**
 * Makes ~/.codex hold Orca's entry, appended last in each event Codex listed,
 * with Codex's own hash for it approved and enabled. Writes only what differs;
 * an approval goes in before its entry, and is taken back if the entry write
 * fails, so Orca's own writes never leave its entry unapproved. Never throws.
 */
export async function reconcileRealHomeCodexHookEntries(args: {
  hashes: CodexHookHashes
  isEnabled: () => boolean
  userDataPath: string
}): Promise<RealHomeCodexHookReconcile> {
  try {
    return await runExclusivelyForCodexTrustConfig(getRealHomeConfigTomlPath(), async () =>
      args.isEnabled()
        ? reconcileRealHomeCodexHookEntriesExclusively(args.hashes, args.userDataPath)
        : { outcome: 'disabled', approvals: [] }
    )
  } catch (error) {
    console.warn('[codex-real-home-hooks] could not reconcile Orca entries in ~/.codex:', error)
    return { outcome: 'unavailable', approvals: [] }
  }
}

function reconcileRealHomeCodexHookEntriesExclusively(
  hashes: CodexHookHashes,
  userDataPath: string
): RealHomeCodexHookReconcile {
  const unavailable: RealHomeCodexHookReconcile = { outcome: 'unavailable', approvals: [] }
  const hooksJsonPath = getRealHomeHooksJsonPath()
  const tomlPath = getRealHomeConfigTomlPath()
  const hooksWritePath = resolveHooksJsonWritePath(hooksJsonPath)
  // Why: the pre-write guard compares against these bytes; a separate later
  // read would let a concurrent save land between parse and write.
  const { raw: previousRaw, config } = readHooksJsonWithRaw(hooksJsonPath)
  // Why: an unparseable user file is never clobbered, and Codex rejects unknown root keys.
  if (!config || Object.keys(config).some((key) => key !== 'hooks')) {
    return unavailable
  }
  const material = getCodexManagedHookInstallMaterial()
  const sourcePath = getRealHomeHookKeySourcePath()
  const plan = planRealHomeCodexHookEntries({
    hooks: config.hooks ?? {},
    sourcePath,
    // Why only listed events: an entry Codex has no hash for would wait for review.
    material: {
      ...material,
      events: material.events.filter((eventName) => hashes[CODEX_EVENT_LABEL[eventName]])
    },
    isOrcaCommand: createManagedCommandMatcher(getCodexManagedScriptFileName())
  })
  const approvals = plan.managedEntries.map((entry) => ({
    ...entry,
    trustedHash: hashes[entry.eventLabel],
    // Why: Orca's setting is the only off switch for its hook (a /hooks toggle-off is overridden).
    enabled: true
  }))
  const trustStates = readHookTrustEntries(tomlPath)
  const missing = findMissingCodexHookApprovals(approvals, trustStates)
  const stale = findStaleOrcaApprovals(trustStates, approvals, sourcePath, hashes)
  if (!plan.changed && missing.length === 0 && stale.length === 0) {
    return { outcome: 'unchanged', approvals }
  }

  writeManagedScript(material.scriptPath, material.script)
  try {
    writeCodexHookApprovalsBeforeEntries(tomlPath, missing, () => {
      if (!plan.changed) {
        return
      }
      backupRealHomeHooksJsonOnce(userDataPath, previousRaw)
      mutateRealHomeHooksPreservingUserTrust({
        sourcePath,
        tomlPath,
        beforeHooks: config.hooks ?? {},
        afterHooks: plan.hooks,
        writeHooks: () => {
          assertHooksJsonGeneration(hooksJsonPath, hooksWritePath, previousRaw)
          // Why: unknown fields inside the file belong to the user; preserve them verbatim.
          writeHooksJson(hooksWritePath, { ...config, hooks: plan.hooks }, { preserveMode: true })
        }
      })
    })
  } catch (error) {
    console.warn('[codex-real-home-hooks] could not write Orca entries:', error)
    return unavailable
  }
  if (stale.length > 0) {
    removeHookTrustEntries(tomlPath, stale)
  }
  return { outcome: 'written', approvals }
}

/**
 * Approvals Orca wrote for a slot its entry has left, such as after a user
 * inserted a hook ahead of it. Owned only while they still hold Orca's hash.
 */
function findStaleOrcaApprovals(
  trustStates: ReadonlyMap<string, CodexHookTrustState>,
  approvals: readonly CodexTrustEntry[],
  sourcePath: string,
  hashes: CodexHookHashes
): string[] {
  const wanted = new Set(
    approvals.map((entry) => normalizeHookTrustKeyForLookup(computeTrustKey(entry)))
  )
  return [...trustStates].flatMap(([key, state]) => {
    const parts = parseTrustKey(key)
    return parts &&
      !wanted.has(normalizeHookTrustKeyForLookup(key)) &&
      codexHookSourcePathsEqual(parts.sourcePath, sourcePath) &&
      state.trustedHash !== undefined &&
      state.trustedHash === hashes[parts.eventLabel]
      ? [key]
      : []
  })
}

/**
 * The user's explicit opt-out: strips Orca's entry and its trust from the real
 * ~/.codex, moving the approvals of user hooks whose positions shift. Never throws.
 */
export async function removeRealHomeCodexHookForOptOut(
  hashes: CodexHookHashes | null = null
): Promise<'removed' | 'unavailable'> {
  try {
    return await runExclusivelyForCodexTrustConfig(getRealHomeConfigTomlPath(), async () => {
      const lane = await sweepRealHomeCodexHook(hashes)
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
    console.warn('[codex-real-home-hooks] opt-out cleanup failed:', error)
    return 'unavailable'
  }
}
