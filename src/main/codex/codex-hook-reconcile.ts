import { tmpdir } from 'node:os'
import { resolveCodexCommand } from '../codex-cli/command'
import { dedupeInFlightRun } from '../in-flight-run-dedupe'
import { getManagedCommand, getManagedScriptPath } from './codex-hook-definition'
import { getOrcaUserDataPath, getSystemCodexHomePath } from './codex-home-paths'
import {
  deriveCodexHookHashes,
  listCodexHooks,
  probeCodexVersion
} from './codex-hook-trust-derivation'
import {
  fingerprintCodex,
  memoizeCodexHookTrust,
  MISSING_CODEX_FINGERPRINT,
  readMemoizedCodexHookTrust,
  readMemoizedVersionHashes,
  type CodexHookTrustAnswer
} from './codex-hook-trust-memo'
import {
  reconcileRealHomeCodexHookEntries,
  removeRealHomeCodexHookForOptOut
} from './codex-real-home-hook-install'
import {
  computeTrustKey,
  normalizeHookTrustKeyForLookup,
  type CodexTrustEntry
} from './config-toml-trust'

/**
 * Keeps Orca's Codex hook entry in ~/.codex true to the setting and to the
 * codex binary in use. One never-throwing function, called at app start, on
 * the setting turning on, on each native pane spawn, and on Orca-side launch
 * prep and resume. Each call reads the setting then. A call that finds the
 * entry, its approval and the binary unchanged reads two files and spawns
 * nothing; a new Codex binary costs one `codex --version`, and one throwaway
 * `hooks/list` only when that version is new.
 */

// Why retried soon: a timeout at a loaded boot must not cost status until a restart.
const TRANSIENT_FAILURE_RETRY_MS = 60_000
// Why bounded: a launch waits only for an answer already on its way, never a cold derivation.
export const CODEX_HOOK_LAUNCH_WAIT_MS = 3_000

type ReconcileConfig = {
  isEnabled: () => boolean
  /** Whether Orca's launches run Codex on ~/.codex (system default, no custom CODEX_HOME). */
  usesRealHome: () => boolean
}

/** What the last reconcile learned, for status: its answer and, after a write, Codex's own read. */
export type CodexHookReconcileVerdict = {
  answer: CodexHookTrustAnswer
  verified: 'trusted' | 'rejected' | 'unverified' | null
}

// Why null outside the app: the CLI's process leaves ~/.codex to the app's next reconcile.
let config: ReconcileConfig | null = null
let running: Promise<void> | null = null
let rerun = false
let spawnReconcileScheduled = false
let lastAnswer: CodexHookTrustAnswer | null = null
let verified: CodexHookReconcileVerdict['verified'] = null
const derivations = new Map<string, Promise<CodexHookTrustAnswer>>()
const transientFailures = new Map<string, { retryAt: number; answer: CodexHookTrustAnswer }>()
let hashResolverForTesting: ((codexPath: string) => Promise<CodexHookTrustAnswer>) | null = null

/** App start, main process only: the settings readers, and the first reconcile once PATH is hydrated. */
export function startCodexHookReconcile(
  options: ReconcileConfig & { pathReady?: Promise<unknown> }
): () => void {
  config = { isEnabled: options.isEnabled, usesRealHome: options.usesRealHome }
  void reconcileCodexHooks({ after: options.pathReady })
  return () => {
    config = null
  }
}

/** Never throws; a call while one runs makes that one run again, so no change is missed. */
export function reconcileCodexHooks(options: { after?: Promise<unknown> } = {}): Promise<void> {
  if (running) {
    rerun = true
    return running
  }
  const after = options.after ?? Promise.resolve()
  running = after.catch(() => {}).then(runUntilSettled)
  return running
}

/** A native pane spawned: reconciles on the next tick, off the spawn's path, in the app only. */
export function scheduleCodexHookReconcile(): void {
  // Why once: one spawn builds its env through several builders.
  if (config && !spawnReconcileScheduled) {
    spawnReconcileScheduled = true
    setImmediate(() => {
      spawnReconcileScheduled = false
      void reconcileCodexHooks()
    })
  }
}

/** A reconcile, waited for at most `timeoutMs`: a launch goes ahead rather than wait longer. */
export async function reconcileCodexHooksWithin(timeoutMs: number): Promise<void> {
  await settleWithin(reconcileCodexHooks(), timeoutMs)
}

export function getCodexHookReconcileVerdict(): CodexHookReconcileVerdict | null {
  return lastAnswer ? { answer: lastAnswer, verified } : null
}

function isEnabledNow(): boolean {
  return config?.isEnabled() === true
}

async function runUntilSettled(): Promise<void> {
  for (;;) {
    rerun = false
    try {
      await reconcileOnce()
    } catch (error) {
      console.warn('[codex-hook-reconcile] Codex hook reconcile failed:', error)
    }
    // Why decided and cleared in one step: a call in between would mark a finished run.
    if (!rerun) {
      running = null
      return
    }
  }
}

async function reconcileOnce(): Promise<void> {
  if (!isEnabledNow() || !config?.usesRealHome()) {
    return
  }
  const codexPath = resolveCodexCommand()
  const answer = await resolveCodexHookHashes(codexPath)
  if (!answer.hashes) {
    return
  }
  const result = await reconcileRealHomeCodexHookEntries({
    hashes: answer.hashes,
    isEnabled: isEnabledNow,
    userDataPath: getOrcaUserDataPath()
  })
  if (result.outcome !== 'written') {
    return
  }
  verified = await verifyRealHomeCodexHook(codexPath, result.approvals)
  if (verified === 'rejected') {
    // Why: an entry Codex does not accept is a review screen; this binary gets no entry until it changes.
    memoizeCodexHookTrust(codexPath, fingerprintCodex(codexPath), getHookCommand(), {
      codexVersion: answer.codexVersion,
      hashes: null,
      failure: `Codex ${answer.codexVersion} did not accept Orca's approval of its status hook`
    })
    await removeRealHomeCodexHookForOptOut(answer.hashes)
  }
}

function getHookCommand(): string {
  return getManagedCommand(getManagedScriptPath())
}

/**
 * Codex's hashes for Orca's entry from `codexPath`: memoized per binary and
 * per version, asked of Codex otherwise. Never throws; one question per binary at a time.
 */
export async function resolveCodexHookHashes(
  codexPath: string = resolveCodexCommand()
): Promise<CodexHookTrustAnswer> {
  const answer = await (hashResolverForTesting ?? lookupCodexHookHashes)(codexPath)
  if (lastAnswer?.codexVersion !== answer.codexVersion) {
    verified = null
  }
  lastAnswer = answer
  return answer
}

function lookupCodexHookHashes(codexPath: string): Promise<CodexHookTrustAnswer> {
  const command = getHookCommand()
  const fingerprint = fingerprintCodex(codexPath)
  if (fingerprint === MISSING_CODEX_FINGERPRINT) {
    return Promise.resolve({
      codexVersion: null,
      hashes: null,
      failure: `${codexPath} was not found`
    })
  }
  const memoized = readMemoizedCodexHookTrust(codexPath, command, fingerprint)
  if (memoized) {
    return Promise.resolve(memoized)
  }
  if (!config) {
    // Why: only the app asks Codex; the CLI's process reads what the app learned.
    return Promise.resolve({
      codexVersion: null,
      hashes: null,
      failure: 'Orca has not asked this Codex for its hook approval yet'
    })
  }
  const transient = transientFailures.get(fingerprint)
  if (transient && transient.retryAt > Date.now()) {
    return Promise.resolve(transient.answer)
  }
  return dedupeInFlightRun(derivations, fingerprint, () =>
    askCodexForHookHashes(codexPath, command, fingerprint)
  )
}

/** Codex's answer for a launch into a managed home; null when it is not known within the wait. */
export function resolveCodexHookAnswerForLaunch(): Promise<CodexHookTrustAnswer | null> {
  return settleWithin(resolveCodexHookHashes(), CODEX_HOOK_LAUNCH_WAIT_MS)
}

async function askCodexForHookHashes(
  codexPath: string,
  command: string,
  fingerprint: string
): Promise<CodexHookTrustAnswer> {
  try {
    const probe = await probeCodexVersion(codexPath, 30_000)
    const answer: CodexHookTrustAnswer & { transient?: boolean } = probe.version
      ? (readMemoizedVersionHashes(probe.version, command) ??
        (await deriveCodexHookHashes(codexPath, command, probe.version)))
      : {
          codexVersion: null,
          hashes: null,
          failure: `${codexPath} did not report its version`,
          transient: probe.timedOut
        }
    if (answer.transient) {
      transientFailures.set(fingerprint, {
        retryAt: Date.now() + TRANSIENT_FAILURE_RETRY_MS,
        answer
      })
    } else {
      transientFailures.delete(fingerprint)
      memoizeCodexHookTrust(codexPath, fingerprint, command, answer)
    }
    return answer
  } catch (error) {
    const answer: CodexHookTrustAnswer = {
      codexVersion: null,
      hashes: null,
      failure: error instanceof Error ? error.message : String(error)
    }
    transientFailures.set(fingerprint, { retryAt: Date.now() + TRANSIENT_FAILURE_RETRY_MS, answer })
    return answer
  }
}

/**
 * One read-only `hooks/list` against ~/.codex after a write: 'trusted' when
 * Codex lists every entry Orca approved as trusted and enabled.
 */
async function verifyRealHomeCodexHook(
  codexPath: string,
  approvals: readonly CodexTrustEntry[]
): Promise<'trusted' | 'rejected' | 'unverified'> {
  try {
    // Why the same home spelling as panes: an explicit CODEX_HOME keys entries by its real path.
    const explicitHome = process.env.CODEX_HOME?.trim() ? getSystemCodexHomePath() : null
    const listings = await listCodexHooks(codexPath, explicitHome, tmpdir())
    const byKey = new Map(
      listings.map((listing) => [normalizeHookTrustKeyForLookup(listing.key), listing])
    )
    return approvals.every((entry) => {
      const listing = byKey.get(normalizeHookTrustKeyForLookup(computeTrustKey(entry)))
      return listing?.trustStatus === 'trusted' && listing.enabled !== false
    })
      ? 'trusted'
      : 'rejected'
  } catch (error) {
    console.warn('[codex-hook-reconcile] could not verify Orca entries with Codex:', error)
    return 'unverified'
  }
}

async function settleWithin<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    work,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
  ])
  clearTimeout(timer)
  return result
}

export const _internals = {
  resetForTesting(): void {
    config = null
    running = null
    rerun = false
    spawnReconcileScheduled = false
    lastAnswer = null
    verified = null
    derivations.clear()
    transientFailures.clear()
  },
  /** Stands in for asking a real Codex; null restores the real lookup. */
  setHashResolverForTesting(
    resolver: ((codexPath: string) => Promise<CodexHookTrustAnswer>) | null
  ): void {
    hashResolverForTesting = resolver
  }
}
