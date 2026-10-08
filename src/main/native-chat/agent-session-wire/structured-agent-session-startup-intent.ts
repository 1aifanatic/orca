// Picks made while a child started are the conversation's intent, recorded at once and never a
// provider write the pick waits on. The child launched with the options saved when its start
// began; whatever the record holds now that differs is applied before the child is handed anything,
// model before effort, since an effort is only valid for the model it is set on.

import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'
import type { StructuredAgentSessionOptionRevisions } from './structured-agent-session-option-revisions'

const APPLY_ORDER = ['model', 'effort']

function applyRank(key: string): number {
  const rank = APPLY_ORDER.indexOf(key)
  return rank === -1 ? APPLY_ORDER.length : rank
}

/** Each saved value the child did not launch with, in the order a provider can take them. */
export function structuredAgentSessionStartupIntentWrites(
  launched: Readonly<Record<string, string>>,
  saved: Readonly<Record<string, string>> | undefined
): [key: string, value: string][] {
  return Object.entries(saved ?? {})
    .filter(([key, value]) => launched[key] !== value)
    .sort(([a], [b]) => applyRank(a) - applyRank(b))
}

/** Applies the intent; a write that fails is reported and leaves the record's pick for the next
 *  start, never blocking the start. A close, Stop or quit ends the writes. */
export async function applyStructuredAgentSessionStartupIntent(
  context: {
    deps: Pick<StructuredAgentSessionHostDeps, 'adapter' | 'store' | 'logger'>
    acquireAborts: Pick<StructuredAgentSessionAcquireAborts, 'begin'>
    optionRevisions: Pick<StructuredAgentSessionOptionRevisions, 'advance'>
  },
  sessionId: string,
  child: StructuredAgentSessionProviderChildIdentity,
  launched: Readonly<Record<string, string>>
): Promise<void> {
  const writes = structuredAgentSessionStartupIntentWrites(
    launched,
    context.deps.store.getRecord(sessionId)?.options
  )
  if (writes.length === 0) {
    return
  }
  const wait = context.acquireAborts.begin(sessionId)
  try {
    for (const [key, value] of writes) {
      if (wait.signal.aborted) {
        return
      }
      try {
        await context.deps.adapter.setOption({
          sessionId,
          key,
          value,
          fence: child.fence,
          signal: wait.signal
        })
      } catch (error) {
        context.deps.logger.warn('applying a pick made while the agent started failed', {
          scope: 'startup-intent',
          sessionId,
          key,
          error
        })
      } finally {
        // As a ready child's pick: whatever the write's outcome, a report read before it is stale.
        context.optionRevisions.advance(sessionId)
      }
    }
  } finally {
    wait.end()
  }
}
