import {
  createManagedCommandMatcher,
  readHooksJsonWithRaw,
  type HooksConfig,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import {
  assertHooksJsonGeneration,
  backupRealHomeHooksJsonOnce,
  getRealHomeConfigTomlPath,
  getRealHomeHookKeySourcePaths,
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
import {
  findEventsHoldingOlderOrcaEntries,
  listFrozenOrcaEntries,
  planRealHomeCodexHookEntries
} from './codex-real-home-hook-entry-plan'
import type { CodexHookHashes } from './codex-hook-trust-derivation'
import {
  findMissingCodexHookApprovals,
  readsEntryAtApprovedSlot,
  writeCodexHookApprovalsBeforeEntries
} from './codex-hook-approval-first-write'
import {
  codexHookSourcePathsEqual,
  computeTrustKey,
  isCodexConfigTomlRefusedError,
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
 * - 'unavailable': ~/.codex cannot take Orca's approved entry (`reason` says why).
 * - 'disabled': hooks were off when the lane came free; nothing written.
 */
export type RealHomeCodexHookOutcome = 'unchanged' | 'written' | 'unavailable' | 'disabled'

/**
 * - 'full': launches use ~/.codex: add, convert (when asked) and approve Orca's entry.
 * - 'approve-existing': launches use a managed home; keep an entry already in
 *   ~/.codex approved for Codex runs outside Orca, and add nothing.
 */
export type RealHomeCodexHookMode = 'full' | 'approve-existing'

export type RealHomeCodexHookReconcile = {
  outcome: RealHomeCodexHookOutcome
  /** Orca's entries with the approval each needs, keyed as Codex keys them. */
  approvals: CodexTrustEntry[]
  reason?: string
  /** The reason is the hooks file itself, which the routing gate re-reads on its own. */
  fromHooksFile?: boolean
  /** Whether an older build's entries were up for conversion, so a pending request is served. */
  converted: boolean
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
  /** App start and the setting turning on; a launch never fights a running older build. */
  convertOlderForms: boolean
  mode?: RealHomeCodexHookMode
}): Promise<RealHomeCodexHookReconcile> {
  try {
    return await runExclusivelyForCodexTrustConfig(getRealHomeConfigTomlPath(), async () =>
      args.isEnabled()
        ? reconcileRealHomeCodexHookEntriesExclusively({ mode: 'full', ...args })
        : { outcome: 'disabled', approvals: [], converted: false }
    )
  } catch (error) {
    console.warn('[codex-real-home-hooks] could not reconcile Orca entries in ~/.codex:', error)
    return { outcome: 'unavailable', approvals: [], reason: describeError(error), converted: false }
  }
}

function reconcileRealHomeCodexHookEntriesExclusively(args: {
  hashes: CodexHookHashes
  userDataPath: string
  convertOlderForms: boolean
  mode: RealHomeCodexHookMode
}): RealHomeCodexHookReconcile {
  const { hashes, mode } = args
  const hooksJsonPath = getRealHomeHooksJsonPath()
  const tomlPath = getRealHomeConfigTomlPath()
  const hooksWritePath = resolveHooksJsonWritePath(hooksJsonPath)
  // Why: the pre-write guard compares against these bytes; a separate later
  // read would let a concurrent save land between parse and write.
  const { raw: previousRaw, config } = readHooksJsonWithRaw(hooksJsonPath)
  if (!config || !isAddableHooksFile(config)) {
    return {
      outcome: 'unavailable',
      approvals: [],
      reason: describeHooksFileProblem(hooksJsonPath),
      fromHooksFile: true,
      converted: false
    }
  }
  const hooks = config.hooks ?? {}
  const material = getCodexManagedHookInstallMaterial()
  const [sourcePath, ...otherSpellings] = getRealHomeHookKeySourcePaths()
  const isOrcaCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
  // Why only listed events: an entry Codex has no hash for would wait for review.
  const listed = material.events.filter((eventName) => hashes[CODEX_EVENT_LABEL[eventName]])
  const olderEvents =
    mode === 'full' && args.convertOlderForms
      ? []
      : findEventsHoldingOlderOrcaEntries({
          hooks,
          material: { ...material, events: listed },
          isOrcaCommand
        })
  const eventMaterial = {
    ...material,
    events: listed.filter((eventName) => !olderEvents.includes(eventName))
  }
  const plan =
    mode === 'full'
      ? planRealHomeCodexHookEntries({ hooks, sourcePath, material: eventMaterial, isOrcaCommand })
      : {
          hooks,
          changed: false,
          managedEntries: listFrozenOrcaEntries({ hooks, sourcePath, material: eventMaterial })
        }
  const approvals = [sourcePath, ...otherSpellings].flatMap((keySource) =>
    plan.managedEntries.map((entry) => ({
      ...entry,
      sourcePath: keySource,
      trustedHash: hashes[entry.eventLabel],
      // Why: Orca's setting is the only off switch for its hook (a /hooks toggle-off is overridden).
      enabled: true
    }))
  )
  const converted = mode === 'full' && args.convertOlderForms
  const trustStates = readHookTrustEntries(tomlPath)
  const missing = findMissingCodexHookApprovals(approvals, trustStates)
  const stale = findStaleOrcaApprovals(
    trustStates,
    approvals,
    [sourcePath, ...otherSpellings],
    hashes,
    new Set(
      listed
        .filter((eventName) => olderEvents.includes(eventName))
        .map((eventName) => CODEX_EVENT_LABEL[eventName])
    )
  )
  if (!plan.changed && missing.length === 0 && stale.length === 0) {
    return { outcome: 'unchanged', approvals, converted }
  }

  writeManagedScript(material.scriptPath, material.script)
  try {
    writeCodexHookApprovalsBeforeEntries(
      tomlPath,
      missing,
      () => {
        if (!plan.changed) {
          return
        }
        backupRealHomeHooksJsonOnce(args.userDataPath, previousRaw)
        mutateRealHomeHooksPreservingUserTrust({
          sourcePaths: [sourcePath, ...otherSpellings],
          tomlPath,
          beforeHooks: hooks,
          afterHooks: plan.hooks,
          writeHooks: () => {
            assertHooksJsonGeneration(hooksJsonPath, hooksWritePath, previousRaw)
            // Why: unknown fields inside the file belong to the user; preserve them verbatim.
            writeHooksJson(hooksWritePath, { ...config, hooks: plan.hooks }, { preserveMode: true })
          }
        })
      },
      readsEntryAtApprovedSlot(hooksJsonPath)
    )
  } catch (error) {
    console.warn('[codex-real-home-hooks] could not write Orca entries:', error)
    return { outcome: 'unavailable', approvals: [], reason: describeError(error), converted: false }
  }
  try {
    removeHookTrustEntries(tomlPath, stale)
  } catch (error) {
    // Why still written: the entry and its approval are in place; a leftover approval matches no hook.
    console.warn('[codex-real-home-hooks] could not drop stale Orca approvals:', error)
  }
  return { outcome: 'written', approvals, converted }
}

// Why: an unparseable user file is never clobbered, and Codex rejects unknown root keys.
function isAddableHooksFile(config: HooksConfig): boolean {
  return Object.keys(config).every((key) => key === 'hooks')
}

function describeHooksFileProblem(hooksJsonPath: string): string {
  return `${hooksJsonPath} is not a hooks file Orca can add to`
}

/** Why ~/.codex/hooks.json cannot take Orca's entry right now, read from the file; null when it can. */
export function readRealHomeHooksFileProblem(): string | null {
  const hooksJsonPath = getRealHomeHooksJsonPath()
  const { config } = readHooksJsonWithRaw(hooksJsonPath)
  return config && isAddableHooksFile(config) ? null : describeHooksFileProblem(hooksJsonPath)
}

function describeError(error: unknown): string {
  if (isCodexConfigTomlRefusedError(error)) {
    return `${getRealHomeConfigTomlPath()} keeps hook approvals inline, so Orca cannot add its own there`
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Approvals Orca wrote for a slot its entry has left, such as after a user
 * inserted a hook ahead of it. Owned only while they still hold Orca's hash.
 * Never in a deferred event: this run did not plan it, so its entries keep theirs.
 */
function findStaleOrcaApprovals(
  trustStates: ReadonlyMap<string, CodexHookTrustState>,
  approvals: readonly CodexTrustEntry[],
  sourcePaths: readonly string[],
  hashes: CodexHookHashes,
  deferredLabels: ReadonlySet<string>
): string[] {
  const wanted = new Set(
    approvals.map((entry) => normalizeHookTrustKeyForLookup(computeTrustKey(entry)))
  )
  return [...trustStates].flatMap(([key, state]) => {
    const parts = parseTrustKey(key)
    return parts &&
      !deferredLabels.has(parts.eventLabel) &&
      !wanted.has(normalizeHookTrustKeyForLookup(key)) &&
      sourcePaths.some((sourcePath) => codexHookSourcePathsEqual(parts.sourcePath, sourcePath)) &&
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
