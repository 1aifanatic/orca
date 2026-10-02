// A bound on how long a caller waits on teardown, never on the teardown itself.
//
// Two uses. A caller joining a child's close waits this long for the exit's proof and then answers
// `unverifiable`; the close keeps running, and a proof that lands later still ends the record. Each
// wind-down step after the exit is bounded the same way, so one hung step is reported and the rest
// still run.

import type { StructuredAgentSessionEvictionStep } from './structured-agent-session-eviction'

export const STRUCTURED_AGENT_SESSION_EVICTION_STEP_TIMEOUT_MS = 10_000

export class StructuredAgentSessionEvictionTimeoutError extends Error {
  constructor(
    readonly step: string,
    readonly timeoutMs: number
  ) {
    super(`agent session eviction step "${step}" did not finish within ${timeoutMs}ms`)
    this.name = 'StructuredAgentSessionEvictionTimeoutError'
  }
}

export function withStructuredAgentSessionEvictionDeadline(
  steps: readonly StructuredAgentSessionEvictionStep[],
  timeoutMs = STRUCTURED_AGENT_SESSION_EVICTION_STEP_TIMEOUT_MS
): readonly StructuredAgentSessionEvictionStep[] {
  return steps.map((step) => ({
    name: step.name,
    run: async (context) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.resolve(step.run(context)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new StructuredAgentSessionEvictionTimeoutError(step.name, timeoutMs)),
              timeoutMs
            )
            timer.unref?.()
          })
        ])
      } finally {
        if (timer) {
          clearTimeout(timer)
        }
      }
    }
  }))
}
