// One structured-session mutation, fenced and idempotent.
//
// Every call is its own action with its own client operation id, so a press is never answered
// from an earlier one. The host joins a Stop of a named turn or task pressed while one is still on
// its way; against an older host that does not, this client joins it instead of stopping twice.
// Every result is discarded unless the runtime fence it was issued against is still the current
// one. A write that did not happen is reported once, in the person's words, by the caller that
// knows where to say it; nothing latches.

import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import type { AgentSessionMutationResult } from '../../../../shared/agent-session-wire'
import {
  agentSessionRefusalFailure,
  agentSessionThrownFailure,
  agentSessionWriteKindForMethod as writeKind
} from '../../../../shared/agent-session-write-failure'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import {
  callStructuredAgentSession,
  supportsStructuredAgentSessionStopJoin
} from '@/runtime/structured-agent-session-client'
import { structuredSessionOperationId } from './use-structured-agent-session-outbox'
import { agentSessionWriteFailureText } from './agent-session-write-notice-text'

export type StructuredAgentSessionWriteOutcome<T> =
  | { kind: 'done'; value: T }
  /** Refused or failed, with what to tell the person. */
  | { kind: 'not-done'; notice: string }
  /** Settled for an owner or session this pane no longer shows; there is nothing to say. */
  | { kind: 'dropped' }

type WriteArgs = [method: string, fingerprintMethod: string, fields: Record<string, unknown>]

export type StructuredAgentSessionWrite = <T>(
  ...args: WriteArgs
) => Promise<StructuredAgentSessionWriteOutcome<T>>

/** A write whose failure is shown as a toast; the control that sent it is the way to try again. */
export type StructuredAgentSessionMutate = <T>(...args: WriteArgs) => Promise<T | null>

/** A Stop naming its turn or task; one naming neither acts on whatever runs when the host reaches
 *  it, so a second press is a Stop of its own. */
function namesWhatItStops(fingerprintMethod: string, fields: Record<string, unknown>): boolean {
  if (fingerprintMethod !== 'agentSession.cancel') {
    return false
  }
  return fields.scope === 'background-tasks'
    ? fields.taskId !== undefined
    : fields.turnId !== undefined
}

export function useStructuredAgentSessionMutate(args: {
  sessionId: string
  target: RuntimeClientTarget
  enabled?: boolean
  /** Read at settle time, not at call time: the fence can move while a request
   *  is in flight, and a result from the previous fence is not this session's. */
  stateRef: { current: { fence: number | null } }
}): {
  write: StructuredAgentSessionWrite
  mutate: StructuredAgentSessionMutate
} {
  const { enabled = true, sessionId, stateRef, target } = args
  const inFlightStops = useRef(
    new Map<string, Promise<StructuredAgentSessionWriteOutcome<unknown>>>()
  )
  const enabledRef = useRef(enabled)
  useEffect(() => {
    // Why: update the gate after commit so render stays free of ref mutations.
    enabledRef.current = enabled
  }, [enabled])

  const send = useCallback(
    async <T>(
      method: string,
      fingerprintMethod: string,
      fields: Record<string, unknown>
    ): Promise<StructuredAgentSessionWriteOutcome<T>> => {
      if (!enabled || !enabledRef.current || stateRef.current.fence === null) {
        return { kind: 'dropped' }
      }
      const targetFence = stateRef.current.fence
      let result: AgentSessionMutationResult<T>
      try {
        result = await callStructuredAgentSession<AgentSessionMutationResult<T>>(target, method, {
          envelope: {
            sessionId,
            clientOperationId: structuredSessionOperationId(),
            expectedRuntimeFence: targetFence,
            payloadFingerprint: structuredAgentSessionPayloadFingerprint({
              method: fingerprintMethod,
              sessionId,
              fields
            })
          },
          ...fields
        })
      } catch (error) {
        return enabledRef.current && stateRef.current.fence === targetFence
          ? {
              kind: 'not-done',
              notice: agentSessionWriteFailureText(
                agentSessionThrownFailure(
                  error,
                  error instanceof RuntimeRpcCallError ? error.code : undefined
                ),
                writeKind(fingerprintMethod, fields)
              )
            }
          : { kind: 'dropped' }
      }
      if (!result.ok) {
        return enabledRef.current && stateRef.current.fence === targetFence
          ? {
              kind: 'not-done',
              notice: agentSessionWriteFailureText(
                agentSessionRefusalFailure(result.refusal),
                writeKind(fingerprintMethod, fields)
              )
            }
          : { kind: 'dropped' }
      }
      if (!enabledRef.current || stateRef.current.fence !== targetFence) {
        return { kind: 'dropped' }
      }
      return { kind: 'done', value: result.value }
    },
    [enabled, sessionId, stateRef, target]
  )

  const write = useCallback(
    async <T>(
      method: string,
      fingerprintMethod: string,
      fields: Record<string, unknown>
    ): Promise<StructuredAgentSessionWriteOutcome<T>> => {
      if (
        !namesWhatItStops(fingerprintMethod, fields) ||
        (await supportsStructuredAgentSessionStopJoin(target))
      ) {
        return send<T>(method, fingerprintMethod, fields)
      }
      // Temporary, for a host older than its Stop join: remove once every supported host has it.
      const key = `${sessionId}:${method}:${JSON.stringify(fields)}`
      const joined = inFlightStops.current.get(key)
      if (joined) {
        // The first press reports a failure; the one that joined it stays quiet.
        return joined.then((outcome) =>
          outcome.kind === 'not-done'
            ? { kind: 'dropped' }
            : // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the key names the method and fields, so the joined promise is this very call and settles to its T.
              (outcome as StructuredAgentSessionWriteOutcome<T>)
        )
      }
      const stopping = send<T>(method, fingerprintMethod, fields)
      inFlightStops.current.set(key, stopping)
      // Gone once it settles, so the next press is a new Stop.
      void stopping.finally(() => {
        if (inFlightStops.current.get(key) === stopping) {
          inFlightStops.current.delete(key)
        }
      })
      return stopping
    },
    [send, sessionId, target]
  )

  const mutate = useCallback(
    async <T>(...writeArgs: WriteArgs): Promise<T | null> => {
      const outcome = await write<T>(...writeArgs)
      if (outcome.kind === 'not-done') {
        toast.error(outcome.notice)
      }
      return outcome.kind === 'done' ? outcome.value : null
    },
    [write]
  )

  return { write, mutate }
}
