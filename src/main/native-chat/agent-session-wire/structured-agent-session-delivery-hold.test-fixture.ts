// Ways a test holds a session's work at a chosen step, so a Stop or close asked for meanwhile runs
// in a known order against the delivery loop's handover.

import { vi } from 'vitest'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

/** Holds the delivery loop's next step at its first write, inside the session's lane, until
 *  `release`: a Stop or close asked for meanwhile runs ahead of the handover. `held` resolves
 *  once the step has reached the hold. */
export function holdDelivery(): { held: Promise<void>; release: () => void } {
  const gate = Promise.withResolvers<void>()
  const reached = Promise.withResolvers<void>()
  const reject = AgentSessionJournal.prototype.rejectQueuedSubmissions
  const step = vi
    .spyOn(AgentSessionJournal.prototype, 'rejectQueuedSubmissions')
    .mockImplementation(async function (this: AgentSessionJournal, ...args) {
      // The step's leftover sweep, the one write every delivery step makes first.
      if (args[1].rejection.kind === 'hostRestarted') {
        step.mockRestore()
        reached.resolve()
        await gate.promise
      }
      return reject.apply(this, args)
    })
  return { held: reached.promise, release: () => gate.resolve() }
}

/** Holds the session's lane until the returned release: whatever is asked for meanwhile runs in
 *  the order it was asked, ahead of a handover the delivery loop asks for after it. */
export function holdLane(host: StructuredAgentSessionHost, sessionId: string): () => void {
  const held = Promise.withResolvers<void>()
  void host['tasks'].serialize(sessionId, () => held.promise)
  return () => held.resolve()
}
