// Whether THIS process owns its profile's structured chats.
//
// The claim is taken at runtime start, before `orca-runtime.json` is published, so a process that
// does not own the chats never advertises itself as the one that does. A process that cannot take
// it, because another holds it or because the lock file will not open, serves every structured-chat
// request a refusal and keeps retrying; publishing waits for the retry to land. One claim per
// process; a claim on another state directory releases the previous one first.

import { resolve } from 'node:path'
import type { AgentSessionJournalProcessKind } from '../../shared/agent-session-refusal-details'
import {
  agentSessionRefusalError,
  isAgentSessionRefusalError,
  type AgentSessionRefusalError
} from '../../shared/agent-session-wire-refusals'
import {
  JOURNAL_OWNER_LOCK_FILE,
  retryJournalOwnerLock,
  tryAcquireJournalOwnerLock,
  type JournalOwnerLock
} from '../native-chat/agent-session-journal/journal-owner-lock'

/** Which way the refused process can be told to get out of the way. */
export type JournalOwnerProcessKind = AgentSessionJournalProcessKind

// For logs and released clients; current clients pick their words from the reason and kind.
export const JOURNAL_OWNER_REFUSAL_MESSAGES: Record<JournalOwnerProcessKind, string> = {
  'dev-desktop':
    'Chats are open in another Orca window using this profile. Quit that Orca to use chats here, or start this one with its own profile (ORCA_DEV_USER_DATA_PATH).',
  packaged: 'Chats are open in another Orca process using this profile. Quit it to use chats here.',
  orcad:
    'Chats are open in another Orca process using this data folder. Stop it, or give this one its own folder (ORCA_USER_DATA).'
}

type Refused = {
  stateDirectory: string
  retry: { cancel: () => void }
  /** Why the latest attempt could not open the lock, or null while another process holds it. */
  failure: { error: unknown } | null
}

let processKind: JournalOwnerProcessKind = 'packaged'
let held: JournalOwnerLock | null = null
let refused: Refused | null = null
let installRefusal: AgentSessionRefusalError | null = null
const ownedListeners = new Set<() => void>()

export function setJournalOwnerProcessKind(kind: JournalOwnerProcessKind): void {
  processKind = kind
}

/** The held lock for `stateDirectory`, or null while another process holds it. Throws while the
 *  lock file will not open; either way the claim stays refused and retries. */
export function claimStructuredAgentSessionJournal(
  stateDirectory: string
): JournalOwnerLock | null {
  const directory = resolve(stateDirectory)
  if (held && held.stateDirectory === directory) {
    return held
  }
  if (refused?.stateDirectory === directory) {
    return refusedClaim(refused)
  }
  // A profile switch: the old claim goes before the new one is taken.
  releaseStructuredAgentSessionJournal()
  const claim: Refused = {
    stateDirectory: directory,
    retry: { cancel: () => undefined },
    failure: null
  }
  // Every attempt, the retry's too, records why it failed: not opening the lock is not owning it.
  const attempt = (lockDirectory: string): JournalOwnerLock | null => {
    try {
      const lock = tryAcquireJournalOwnerLock(lockDirectory)
      claim.failure = null
      return lock
    } catch (error) {
      claim.failure = { error }
      return null
    }
  }
  const lock = attempt(directory)
  if (lock) {
    adopt(lock)
    return lock
  }
  if (!claim.failure) {
    console.warn(
      `[structured-agent-session] another process owns ${directory}/${JOURNAL_OWNER_LOCK_FILE}; structured chats are read-refused in this process`
    )
  }
  claim.retry = retryJournalOwnerLock({
    stateDirectory: directory,
    onAcquired: adopt,
    acquire: attempt
  })
  refused = claim
  return refusedClaim(claim)
}

function refusedClaim(claim: Refused): null {
  if (claim.failure) {
    throw claim.failure.error
  }
  return null
}

/** Whether this process is waiting on its claim, whichever way it was refused. */
export function isStructuredAgentSessionJournalClaimRefused(): boolean {
  return refused !== null
}

/** What every structured-chat request gets while another process owns the chats. A lock file
 *  that will not open refuses through the install instead, like the database it guards. */
export function structuredAgentSessionJournalOwnerRefusal(): AgentSessionRefusalError | null {
  if (!refused || refused.failure) {
    return null
  }
  return agentSessionRefusalError(
    'agent_session_journal_unreadable',
    { reason: 'journalOwnedElsewhere', processKind },
    JOURNAL_OWNER_REFUSAL_MESSAGES[processKind]
  )
}

/** Why structured chats are refused in this process, or null when nothing refuses them. */
export function structuredAgentSessionHostRefusal(): AgentSessionRefusalError | null {
  return structuredAgentSessionJournalOwnerRefusal() ?? installRefusal
}

/** Whether `error` is the refusal structured requests are getting right now. */
export function isStructuredAgentSessionHostRefusal(error: unknown): boolean {
  const refusal = structuredAgentSessionHostRefusal()
  return (
    refusal !== null &&
    isAgentSessionRefusalError(error) &&
    error.refusal.code === refusal.refusal.code &&
    error.refusal.message === refusal.refusal.message
  )
}

/** For work that goes on without chats: the refusal chats are getting leaves this process with no
 *  host, and any other install failure still throws. */
export async function ensureStructuredAgentSessionHostUnlessRefused(
  ensureHost: () => Promise<unknown>
): Promise<void> {
  try {
    await ensureHost()
  } catch (error) {
    if (!isStructuredAgentSessionHostRefusal(error)) {
      throw error
    }
  }
}

/** Set when the owner could not open its journal database; cleared by a later install. The
 *  install retries on the next call, so a refusal that can clear does. */
export function recordStructuredAgentSessionHostInstallRefusal(
  refusal: AgentSessionRefusalError | null
): void {
  installRefusal = refusal
}

/** Told when a refused claim is finally granted, so discovery can publish this process. */
export function onStructuredAgentSessionJournalOwned(listener: () => void): () => void {
  ownedListeners.add(listener)
  return () => ownedListeners.delete(listener)
}

/** First, when stopping: a takeover landing during the teardown would install a host after it.
 *  The refusal stands, so a request in that window is still refused rather than claiming. */
export function stopRetryingStructuredAgentSessionJournalClaim(): void {
  refused?.retry.cancel()
}

/** Last, after the journal database is closed. Also stops a refused claim's retry. */
export function releaseStructuredAgentSessionJournal(): void {
  stopRetryingStructuredAgentSessionJournalClaim()
  refused = null
  const lock = held
  held = null
  lock?.release()
}

function adopt(lock: JournalOwnerLock): void {
  refused?.retry.cancel()
  refused = null
  held = lock
  for (const listener of ownedListeners) {
    try {
      listener()
    } catch (error) {
      console.warn('[structured-agent-session] announcing chat journal ownership failed', error)
    }
  }
}
