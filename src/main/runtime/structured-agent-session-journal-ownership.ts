// Whether THIS process owns its profile's structured chats.
//
// The claim is taken at runtime start, before `orca-runtime.json` is published, so a process that
// does not own the chats never advertises itself as the one that does. A process that cannot take
// it serves every structured-chat request a refusal naming what to do, and keeps retrying: the
// owner quitting is what clears it. One claim per process; a claim on another state directory
// releases the previous one first.

import { resolve } from 'node:path'
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
export type JournalOwnerProcessKind = 'dev-desktop' | 'packaged' | 'orcad'

export const JOURNAL_OWNER_REFUSAL_MESSAGES: Record<JournalOwnerProcessKind, string> = {
  'dev-desktop':
    'Chats are open in another Orca window using this profile. Quit that Orca to use chats here, or start this one with its own profile (ORCA_DEV_USER_DATA_PATH).',
  packaged: 'Chats are open in another Orca process using this profile. Quit it to use chats here.',
  orcad:
    'Chats are open in another Orca process using this data folder. Stop it, or give this one its own folder (ORCA_USER_DATA).'
}

type Refused = { stateDirectory: string; retry: { cancel: () => void } }

let processKind: JournalOwnerProcessKind = 'packaged'
let held: JournalOwnerLock | null = null
let refused: Refused | null = null
let installRefusal: AgentSessionRefusalError | null = null
const ownedListeners = new Set<() => void>()

export function setJournalOwnerProcessKind(kind: JournalOwnerProcessKind): void {
  processKind = kind
}

/** The held lock for `stateDirectory`, or null while another process holds it. */
export function claimStructuredAgentSessionJournal(
  stateDirectory: string
): JournalOwnerLock | null {
  const directory = resolve(stateDirectory)
  if (held && held.stateDirectory === directory) {
    return held
  }
  if (refused?.stateDirectory === directory) {
    return null
  }
  // A profile switch: the old claim goes before the new one is taken.
  releaseStructuredAgentSessionJournal()
  const lock = tryAcquireJournalOwnerLock(directory)
  if (lock) {
    adopt(lock)
    return lock
  }
  console.warn(
    `[structured-agent-session] another process owns ${directory}/${JOURNAL_OWNER_LOCK_FILE}; structured chats are read-refused in this process`
  )
  refused = {
    stateDirectory: directory,
    retry: retryJournalOwnerLock({
      stateDirectory: directory,
      onAcquired: adopt,
      onError: (error) =>
        console.warn(
          '[structured-agent-session] retrying the chat journal owner lock failed',
          error
        )
    })
  }
  return null
}

/** What every structured-chat request gets while another process owns the chats. */
export function structuredAgentSessionJournalOwnerRefusal(): AgentSessionRefusalError | null {
  if (!refused) {
    return null
  }
  return agentSessionRefusalError(
    'agent_session_journal_unreadable',
    { reason: 'journalUnavailable' },
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

/** Last, after the journal database is closed. Also stops a refused claim's retry. */
export function releaseStructuredAgentSessionJournal(): void {
  refused?.retry.cancel()
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
