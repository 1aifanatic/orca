import { resolveCodexCommand } from '../codex-cli/command'
import { getManagedCommand, getManagedScriptPath } from './codex-hook-definition'
import { getOrcaUserDataPath } from './codex-home-paths'
import { describeCodexVersion } from './codex-hook-trust-derivation'
import {
  fingerprintCodex,
  memoizeCodexHookRealHomeRefusal,
  readCodexHookRealHomeRefusal,
  _internals as memoInternals,
  type CodexHookTrustAnswer
} from './codex-hook-trust-memo'
import { _internals as lookupInternals, lookupCodexHookHashes } from './codex-hook-hash-lookup'
import { verifyRealHomeCodexHook } from './codex-hook-real-home-verify'
import {
  reconcileRealHomeCodexHookEntries,
  removeRealHomeCodexHookForOptOut
} from './codex-real-home-hook-install'

/**
 * Keeps Orca's Codex hook entry in ~/.codex true to the setting and to the
 * codex binary in use. One never-throwing function, called at app start, on
 * the setting turning on, on each native pane spawn, and on Orca-launched
 * Codex launches and resumes. Each call reads the setting then. After this
 * process has probed a binary once, a call that finds the entry, its approval
 * and the binary unchanged reads two files and spawns nothing; a new Codex
 * binary costs one `codex --version`, and one throwaway `hooks/list` only
 * when that version is new.
 */

// Why bounded: a Codex launch waits only briefly, never for a cold derivation.
export const CODEX_HOOK_LAUNCH_WAIT_MS = 3_000

type ReconcileConfig = {
  isEnabled: () => boolean
  /** Whether the user's selection runs Codex on ~/.codex (system default, no custom CODEX_HOME). */
  usesRealHome: () => boolean
  /** The CODEX_HOME the next native pane gets, null for ~/.codex; may throw while it is unknown. */
  resolveLaunchHome: () => string | null
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
// Why counted: a start or setting-on request is served only by a run that reached the conversion.
let convertRequests = 0
let convertServed = 0
let spawnReconcileScheduled = false
let lastAnswer: CodexHookTrustAnswer | null = null
let verified: CodexHookReconcileVerdict['verified'] = null
// Why derived each run: the lane closes only while the last reconcile could not approve ~/.codex.
let realHomeProblem: string | null = null
let hashResolverForTesting: ((codexPath: string) => Promise<CodexHookTrustAnswer>) | null = null

/** App start, main process only: the settings readers, and the first reconcile once PATH is hydrated. */
export function startCodexHookReconcile(
  options: ReconcileConfig & { pathReady?: Promise<unknown> }
): () => void {
  config = {
    isEnabled: options.isEnabled,
    usesRealHome: options.usesRealHome,
    resolveLaunchHome: options.resolveLaunchHome
  }
  void reconcileCodexHooks({ after: options.pathReady, convertOlderForms: true })
  return () => {
    config = null
  }
}

/**
 * Never throws; a call while one runs makes that one run again, so no change is
 * missed. `convertOlderForms` is app start's and the setting turning on's: only
 * they replace an older build's entry, so a launch never fights a running one.
 */
export function reconcileCodexHooks(
  options: { after?: Promise<unknown>; convertOlderForms?: boolean } = {}
): Promise<void> {
  if (options.convertOlderForms) {
    convertRequests += 1
  }
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
      // Why not join a running one: it reads the files after this spawn anyway, and a rerun would repeat it.
      if (!running) {
        void reconcileCodexHooks()
      }
    })
  }
}

/** A reconcile, waited for at most `timeoutMs`: a Codex launch goes ahead rather than wait longer. */
export async function reconcileCodexHooksWithin(timeoutMs: number): Promise<void> {
  await settleWithin(reconcileCodexHooks(), timeoutMs)
}

export function getCodexHookReconcileVerdict(): CodexHookReconcileVerdict | null {
  return lastAnswer ? { answer: lastAnswer, verified } : null
}

/**
 * Routing gate: false while the last reconcile could not approve Orca's entry
 * in ~/.codex, so launches use the managed home, where status still works. A
 * Codex with no hashes keeps the lane: the managed home could not approve either.
 */
export function isCodexRealHomeLaneUsable(): boolean {
  return realHomeProblem === null
}

/** Why ~/.codex is not used for launches right now; null when it is. */
export function getCodexRealHomeLaneProblem(): string | null {
  return realHomeProblem
}

/**
 * The home status reports on: the CODEX_HOME the next native pane gets in the
 * app, or ~/.codex in a process that does not know the selection (the CLI's).
 */
export function resolveCodexHookStatusHome():
  | { kind: 'real' }
  | { kind: 'managed'; path: string }
  | { kind: 'unknown' } {
  if (!config) {
    return { kind: 'real' }
  }
  try {
    const path = config.resolveLaunchHome()
    return path === null ? { kind: 'real' } : { kind: 'managed', path }
  } catch {
    return { kind: 'unknown' }
  }
}

function isEnabledNow(): boolean {
  return config?.isEnabled() === true
}

async function runUntilSettled(): Promise<void> {
  for (;;) {
    rerun = false
    const requested = convertRequests
    try {
      if (await reconcileOnce(requested > convertServed)) {
        convertServed = requested
      }
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

/** One pass; true when an asked-for conversion of an older build's entry actually ran. */
async function reconcileOnce(convertOlderForms: boolean): Promise<boolean> {
  if (!isEnabledNow() || !config) {
    realHomeProblem = null
    return false
  }
  const full = config.usesRealHome()
  const codexPath = resolveCodexCommand()
  // Why also with a managed account selected: it warms the answer its launches approve with.
  const answer = await resolveCodexHookHashes(codexPath)
  if (!answer.hashes) {
    realHomeProblem = null
    return false
  }
  const fingerprint = fingerprintCodex(codexPath)
  const refusal = readCodexHookRealHomeRefusal(codexPath, fingerprint, answer.codexVersion)
  if (refusal) {
    // Why skip ~/.codex: writing and withdrawing there again changes nothing until this binary changes.
    realHomeProblem = full ? refusal : null
    return false
  }
  for (let attempt = 0; ; attempt += 1) {
    const result = await reconcileRealHomeCodexHookEntries({
      hashes: answer.hashes,
      isEnabled: isEnabledNow,
      userDataPath: getOrcaUserDataPath(),
      convertOlderForms,
      mode: full ? 'full' : 'approve-existing'
    })
    if (full) {
      realHomeProblem = result.outcome === 'unavailable' ? (result.reason ?? 'unavailable') : null
    }
    if (result.outcome !== 'written') {
      return result.converted
    }
    const verification = await verifyRealHomeCodexHook(codexPath, result)
    if (verification === 'lost' && attempt === 0) {
      // Why once more: a concurrent writer dropped the approval Orca just wrote.
      continue
    }
    verified = verification === 'lost' ? 'unverified' : verification
    if (verification === 'rejected') {
      // Why: an entry Codex does not accept is a review screen; ~/.codex gets none from this binary until it changes.
      const reason = `${describeCodexVersion(answer.codexVersion)} did not accept Orca's approval in ~/.codex`
      memoizeCodexHookRealHomeRefusal(codexPath, fingerprint, answer.codexVersion, reason)
      await removeRealHomeCodexHookForOptOut(answer.hashes)
      realHomeProblem = full ? reason : null
    }
    return result.converted
  }
}

function getHookCommand(): string {
  return getManagedCommand(getManagedScriptPath())
}

/**
 * Codex's hashes for Orca's entry from `codexPath`: from this process's memo,
 * else asked of Codex (its version first, then a throwaway `hooks/list` for a
 * new version). Never throws; one question per binary at a time.
 */
export async function resolveCodexHookHashes(
  codexPath: string = resolveCodexCommand()
): Promise<CodexHookTrustAnswer> {
  const answer = await (
    hashResolverForTesting ??
    ((path: string) => lookupCodexHookHashes(path, getHookCommand(), config !== null))
  )(codexPath)
  if (lastAnswer?.codexVersion !== answer.codexVersion) {
    verified = null
  }
  lastAnswer = answer
  return answer
}

/**
 * The answer for a launch into a managed home, waiting at most `waitMs` for one
 * not known yet; null when none came in time.
 */
export function resolveCodexHookAnswerForLaunch(
  waitMs: number
): Promise<CodexHookTrustAnswer | null> {
  return settleWithin(resolveCodexHookHashes(), waitMs)
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
    convertRequests = 0
    convertServed = 0
    spawnReconcileScheduled = false
    lastAnswer = null
    verified = null
    realHomeProblem = null
    lookupInternals.resetForTesting()
    memoInternals.resetForTesting()
  },
  /** Stands in for asking a real Codex; null restores the real lookup. */
  setHashResolverForTesting(
    resolver: ((codexPath: string) => Promise<CodexHookTrustAnswer>) | null
  ): void {
    hashResolverForTesting = resolver
  }
}
