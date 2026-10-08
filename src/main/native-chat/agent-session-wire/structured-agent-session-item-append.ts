import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import {
  providerObservedAppendOptions,
  structuredAgentSessionJournalAppendOptions
} from './structured-agent-session-journal-append-options'

export function createStructuredAgentSessionItemAppend(
  queue: StructuredAgentSessionSinkQueue
): NonNullable<StructuredAgentSessionEventSink['tryAppendItem']> {
  return (identity, body, options) => {
    const observation = providerObservedAppendOptions(options)
    return queue.submit(
      {
        bytes: estimateStructuredAgentSessionItemBytes(identity, body),
        run: (bound) =>
          bound.journal.appendItem(
            identity,
            body,
            structuredAgentSessionJournalAppendOptions(bound.fence, observation)
          )
      },
      options
    )
  }
}
