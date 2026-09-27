// How a conversation command the provider ran ended, read the same way for every provider.

export type StructuredConversationCommandOutcome = {
  outcome: 'success' | 'failure' | 'cancellation'
  error?: string
}

/** What the provider showed of one compaction while it ran. */
export type StructuredCompactionEvidence = {
  /** The provider reported the conversation compacted: Claude's boundary, Codex's item. */
  compacted: boolean
  /** Orca asked the provider to stop the command. */
  interruptRequested: boolean
  /** Why the provider said it failed, when it said. */
  error?: string | null
}

/** Only a compaction the provider reported doing is a success: Claude answers a stopped `/compact`
 *  with the same success result as a finished one, so the result's own verdict cannot decide. With
 *  none, one Orca asked to stop is the user's cancellation; anything else failed. */
export function structuredCompactionOutcome(
  evidence: StructuredCompactionEvidence
): StructuredConversationCommandOutcome {
  if (evidence.compacted) {
    return { outcome: 'success' }
  }
  if (evidence.interruptRequested) {
    return { outcome: 'cancellation' }
  }
  return {
    outcome: 'failure',
    error: evidence.error || 'Compaction was not confirmed by the provider.'
  }
}
