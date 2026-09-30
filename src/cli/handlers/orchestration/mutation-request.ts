import { randomUUID } from 'node:crypto'
import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'
import { readRetryRequestFlag } from '../../retry-request-flag'
import { orchestrationMutationRecoveryError } from '../../orchestration-mutation-recovery'

const MAX_UNAVAILABLE_RETRY_DELAY_MS = 15_000

export async function callOrchestrationMutation<TResult>(
  client: RuntimeClient,
  flags: Map<string, string | boolean>,
  method: string,
  params: unknown,
  options: {
    timeoutMs?: number
    orchestrationCapability?: string
    unavailableRetryMs?: number
  } = {}
) {
  const { unavailableRetryMs = 0, ...callOptions } = options
  // Why: every retry reuses one request id, so the host replays instead of applying the mutation twice.
  const requestId =
    readRetryRequestFlag(flags) ?? (unavailableRetryMs > 0 ? randomUUID() : undefined)
  const deadline = Date.now() + unavailableRetryMs
  for (let delayMs = 1_000; ; delayMs = Math.min(delayMs * 2, MAX_UNAVAILABLE_RETRY_DELAY_MS)) {
    try {
      return requestId
        ? await client.call<TResult>(method, params, {
            ...callOptions,
            orchestrationRequestId: requestId
          })
        : // Why: an empty bag keeps the two-argument call shape callers have always made.
          Object.values(callOptions).some((value) => value !== undefined)
          ? await client.call<TResult>(method, params, callOptions)
          : await client.call<TResult>(method, params)
    } catch (error) {
      const unavailable =
        error instanceof RuntimeClientError && error.code === 'runtime_unavailable'
      if (!unavailable || Date.now() + delayMs > deadline) {
        throw orchestrationMutationRecoveryError(error)
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}
