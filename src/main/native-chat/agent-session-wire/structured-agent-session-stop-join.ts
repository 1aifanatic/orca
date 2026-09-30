import type {
  AgentSessionCancelResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'

type StopResult = AgentSessionMutationResult<AgentSessionCancelResult>

/** This host's Stops still on their way, by the session and the target they name. */
export type StructuredAgentSessionStopsInFlight = Map<string, Promise<StopResult>>

/** A Stop naming its turn or task. One naming neither acts on whatever runs when the host
 *  reaches it, so another press is a Stop of its own; a prompt Cancel's repeat is answered
 *  by the prompt's state. */
function namedStopKey(
  sessionId: string,
  params: { turnId?: string; scope?: 'background-tasks'; taskId?: string; prompt?: unknown }
): string | null {
  if (params.prompt !== undefined) {
    return null
  }
  const target = params.scope === 'background-tasks' ? params.taskId : params.turnId
  return target === undefined ? null : JSON.stringify([sessionId, params.scope ?? 'turn', target])
}

/**
 * A Stop of a target another Stop is still stopping, from any client, waits for that Stop and
 * answers with its result instead of interrupting again. It still passes its own admission
 * (`answerWith`), so its id replays from its own receipt. A first Stop that answered nothing
 * leaves the press to run as a Stop of its own.
 */
export async function joinStructuredAgentSessionStop(
  inFlight: StructuredAgentSessionStopsInFlight,
  params: {
    envelope: { sessionId: string }
    turnId?: string
    scope?: 'background-tasks'
    taskId?: string
    prompt?: unknown
  },
  run: () => Promise<StopResult>,
  answerWith: (value: AgentSessionCancelResult) => Promise<StopResult>
): Promise<StopResult> {
  const key = namedStopKey(params.envelope.sessionId, params)
  if (key === null) {
    return run()
  }
  const running = inFlight.get(key)
  if (running) {
    const first = await running.catch(() => null)
    return first?.ok ? answerWith(first.value) : run()
  }
  const stopping = run()
  inFlight.set(key, stopping)
  const settle = (): void => {
    if (inFlight.get(key) === stopping) {
      inFlight.delete(key)
    }
  }
  stopping.then(settle, settle)
  return stopping
}
