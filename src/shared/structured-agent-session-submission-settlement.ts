// The one reading of a journaled send's dispatch facts. Clients, the host's status projection and
// mobile all decide from this; a ratchet test fails on a new raw read of those facts elsewhere,
// because every earlier copy of this rule drifted from the others.

import type { AgentJournalSubmission } from './agent-session-journal-types'
import { classifyDispatchRejection } from './structured-agent-session-dispatch-rejection'

/**
 * - `open`: the host still holds it and it can yet turn accepted or rejected — pending, queued, or
 *   a live `unknown`. A client keeps its outbox entry for the answer.
 * - `sent`: drawn as an ordinary sent message with nothing left to hold or retry — the provider
 *   took it, or a crash or dead agent left it in doubt for good and the next message is how the
 *   chat continues. An older host's `notDelivered` was that same doubt, inferred from the
 *   transcript; such a host wrote no session row, so that message carries no notice.
 * - `refused`: provably did not happen; `classifyDispatchRejection` says why.
 */
export type StructuredAgentSessionSubmissionSettlement = 'open' | 'sent' | 'refused'

export function structuredAgentSessionSubmissionSettlement(
  submission: Pick<AgentJournalSubmission, 'dispatchState' | 'reason' | 'recovered'> & {
    rejection?: unknown
  }
): StructuredAgentSessionSubmissionSettlement {
  switch (submission.dispatchState) {
    case 'accepted':
      return 'sent'
    case 'pending':
      return 'open'
    case 'unknown':
      // Hosts before the `recovered` flag reached the wire publish only the restart reason.
      return submission.recovered === true ||
        submission.reason === 'host_restarted_before_acknowledgement'
        ? 'sent'
        : 'open'
    case 'rejected':
      return classifyDispatchRejection(submission).kind === 'notDelivered' ? 'sent' : 'refused'
  }
}
