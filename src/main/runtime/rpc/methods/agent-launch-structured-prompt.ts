/**
 * Host-side delivery of a launch's initial text to the structured session the launch just created.
 *
 * It exists so a caller does not have to implement delivery itself. Before this, `agent.launch`
 * created the surface and reported the text as undelivered, which was only workable while the one
 * surface that could send — the desktop renderer's chat — was also the one issuing the launch.
 * Mobile and anything else calling `agent.launch` got an agent and no prompt.
 *
 * Nothing here queues. The durable record that the text is owed already exists and is the journal's
 * own submission row: `performSend` appends it before dispatching and the attach path settles it, so
 * a second host-side copy could only disagree with it. What IS reused is the outbox's entry and
 * envelope builders, so this send is shaped exactly like the renderer's and mobile's — same body,
 * same operation id as client message id, same payload fingerprint.
 *
 * The renderer still delivers its own launch prompts, because its launcher does not call
 * `agent.launch` yet; when it does, its launch-sourced outbox entries become this call.
 */

import {
  createStructuredAgentSessionOutboxEntry,
  structuredAgentSessionSendMutation
} from '../../../../shared/structured-agent-session-outbox'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import { randomUUID } from 'node:crypto'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCaller } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import type { StructuredLaunchPromptDelivery } from '../../../agent-launch/agent-launch-surface-factories'
import { agentSessionSendSubmission } from '../../../../shared/agent-session-wire'

/**
 * The committed transcript row's id, or `null` when nothing was committed.
 *
 * `ok` is the host's own proof of the commit. A send can still throw after appending (for example
 * when operation settlement fails), so throws are reconciled against the host's journal before we
 * under-claim. A resend after that boundary would duplicate the model turn.
 *
 * Deliberately does NOT wait for the dispatch to settle. The row is committed either way, and
 * whether the provider took the turn is the submission's own state to carry.
 */
export async function commitStructuredAgentSessionLaunchPrompt(args: {
  host: StructuredAgentSessionHost | null
  caller: StructuredAgentSessionCaller
  sessionId: string
  fence: number
  text: string
}): Promise<string | null> {
  if (!args.host || args.text.trim().length === 0) {
    return null
  }
  const clientMessageId = createStructuredAgentSessionOperationId(randomUUID)
  const entry = createStructuredAgentSessionOutboxEntry({
    clientMessageId,
    sessionId: args.sessionId,
    text: args.text,
    attachments: [],
    queuedAt: Date.now()
  })
  try {
    const result = await args.host.send(
      args.caller,
      structuredAgentSessionSendMutation(entry, args.fence)
    )
    return result.ok ? result.value.clientMessageId : null
  } catch (error) {
    // Settlement can fail after the journal append. Re-read the authoritative row before asking
    // the caller to resend, otherwise a retry creates a duplicate turn.
    try {
      const committed = (await args.host.journalSnapshot(args.sessionId)).submissions.find(
        (submission) => submission.clientMessageId === clientMessageId
      )
      if (committed) {
        return clientMessageId
      }
    } catch {
      // The host may have gone away before the snapshot; the caller retains the text in that case.
    }
    console.warn('[agent-launch] the session was created, its launch prompt was not sent', error)
    return null
  }
}

/**
 * How long a launch waits for the agent to take its first message. A chat's first message starts
 * its agent, so a caller told "delivered" would claim a start that may still fail; the phone's
 * prompted launch gives up after 90 s, and the create before this is quick.
 */
export const STRUCTURED_LAUNCH_PROMPT_SETTLEMENT_BUDGET_MS = 60_000

/** Said of a prompt whose agent is still starting when the wait ends: it will still be sent. */
export const STRUCTURED_LAUNCH_PROMPT_STILL_STARTING =
  "The agent is still starting. Its prompt will be sent automatically once it starts, so don't send it again."

/**
 * The launch prompt sent as the chat's first message, followed to whether the agent took it.
 *
 * Temporary: an older phone reads any committed row as "Agent started" and marks its notes sent,
 * so the host answers only once the start has settled, within the budget. A start still being
 * retried at the budget answers not taken, keeping the notes, with words saying it will still be
 * sent. The follow-up is phones that watch the message's own settlement and finish then.
 */
export async function deliverStructuredAgentSessionLaunchPrompt(
  args: Parameters<typeof commitStructuredAgentSessionLaunchPrompt>[0] & { budgetMs?: number }
): Promise<StructuredLaunchPromptDelivery> {
  const messageId = await commitStructuredAgentSessionLaunchPrompt(args)
  if (!messageId || !args.host) {
    return { taken: false }
  }
  const settled = await args.host
    .waitForSendSettlement(args.sessionId, messageId, {
      budgetMs: args.budgetMs ?? STRUCTURED_LAUNCH_PROMPT_SETTLEMENT_BUDGET_MS,
      throughStartRetries: true
    })
    .catch(() => undefined)
  const submission = agentSessionSendSubmission(settled?.value)
  switch (submission?.dispatchState) {
    // Unknown is a hand-over whose answer was lost: the agent was given it.
    case 'accepted':
    case 'unknown':
      return { taken: true, messageId }
    case 'rejected':
      return {
        taken: false,
        warning: submission.reason ?? "The agent couldn't start, so its prompt wasn't sent."
      }
    default:
      return { taken: false, warning: STRUCTURED_LAUNCH_PROMPT_STILL_STARTING }
  }
}
