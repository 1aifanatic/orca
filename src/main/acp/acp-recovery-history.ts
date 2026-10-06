// Restart recovery for an ACP agent that keeps its own store: whether a message a crash left
// unconfirmed reached the agent. Presence only: a match settles it as sent, while absence proves
// nothing, so nothing is ever called undelivered. Bounded, and null on any failure; the user can
// always resend or discard, so this never stands between them and the chat.

import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { JournalLoad } from '../native-chat/agent-session-journal/journal-open'
import type { ProviderHistoryWindow } from '../native-chat/agent-session-journal/journal-submission-reconciler'
import type { AcpLaunchSpec } from './acp-launch-specs'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

const RECOVERY_READ_MS = 5_000

/** A person's message as the agent's own store holds it. */
export type AcpStoredUserMessage = {
  /** The store's id for it, claimed at most once. */
  id: string
  blocks: NativeChatBlock[]
  /** Epoch ms the agent recorded it, on this machine's clock. */
  createdAt: number
}

/** Reads the user messages of one provider session from the agent's own store; null when it cannot. */
export type AcpStoredUserMessagesReader = (input: {
  env: Record<string, string>
  providerSessionId: string
  signal: AbortSignal
}) => Promise<AcpStoredUserMessage[] | null>

/**
 * The agent's store keeps no id of Orca's, so a stored message can only match a send by its
 * content. The window holds only messages recorded after every send the journal already
 * accepted and no earlier than the first unconfirmed one, so it never offers an older identical
 * message as the one in doubt.
 */
function recoveryBounds(load: JournalLoad): { after: number; atOrAfter: number } | null {
  let lastAccepted = Number.NEGATIVE_INFINITY
  let firstUnsettled = Number.POSITIVE_INFINITY
  for (const submission of load.state.submissions.values()) {
    if (submission.dispatchState === 'accepted') {
      if (submission.resolvedAt === null) {
        return null
      }
      lastAccepted = Math.max(lastAccepted, submission.resolvedAt)
    } else if (submission.dispatchState === 'pending' || submission.dispatchState === 'unknown') {
      firstUnsettled = Math.min(firstUnsettled, submission.submittedAt)
    }
  }
  return Number.isFinite(firstUnsettled) ? { after: lastAccepted, atOrAfter: firstUnsettled } : null
}

/** The window for one chat; null for an agent whose store Orca does not read. */
export async function readAcpRecoveryHistory(
  input: Pick<AcpStructuredSessionAdapterDeps, 'resolveLaunch' | 'readJournal' | 'logger'> & {
    spec: Pick<AcpLaunchSpec, 'readStoredUserMessages'>
  },
  identity: AgentSessionJournalIdentity
): Promise<ProviderHistoryWindow | null> {
  const { readStoredUserMessages } = input.spec
  if (!readStoredUserMessages || !input.readJournal) {
    return null
  }
  const sessionId = identity.sessionId
  const signal = AbortSignal.timeout(RECOVERY_READ_MS)
  try {
    const load = input.readJournal(sessionId)
    const bounds = load && !load.damage && !load.newer ? recoveryBounds(load) : null
    if (!bounds) {
      return null
    }
    const launch = await waitForPromiseWithSignal(input.resolveLaunch({ identity }), signal)
    if (!launch.resume) {
      return null
    }
    const messages = await waitForPromiseWithSignal(
      readStoredUserMessages({
        env: launch.env,
        providerSessionId: launch.resume.sessionId,
        signal
      }),
      signal
    )
    if (!messages) {
      return null
    }
    return {
      // Absence proves nothing: neither the start of the read nor the end of the agent's work is known.
      boundaryConsistent: false,
      turnInFlight: true,
      items: messages
        .filter(({ createdAt }) => createdAt > bounds.after && createdAt >= bounds.atOrAfter)
        .map((message) => ({
          providerItemId: message.id,
          clientMessageId: null,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId,
            fields: { body: { kind: 'message', role: 'user', blocks: message.blocks } }
          })
        }))
    }
  } catch (error) {
    input.logger?.warn('ACP recovery history could not be read', {
      scope: 'acp-recovery-history',
      sessionId,
      error
    })
    return null
  }
}
