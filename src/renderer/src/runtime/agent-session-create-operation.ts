import type { RuntimeCreateAgentSessionRequest } from '../../../shared/agent-session-host-authority'
import { createAgentSessionOperationId } from './agent-session-operation-id'
import { isRemoteCreateOutcomeUnknown } from './remote-create-outcome'
import { RuntimeRpcCallError } from './runtime-rpc-client'

const MAX_AMBIGUOUS_CREATE_ATTEMPTS = 2

export type AgentSessionCreateOperation = {
  readonly clientOperationId: string
  run<TResult>(invoke: (clientOperationId: string) => Promise<TResult>): Promise<TResult>
}

function isAmbiguousCreateFailure(error: unknown): boolean {
  // Why: an RPC failure proves the host answered unless it carries a transport code, which is how
  // the desktop bridge reports a lost reply. Other transport loss is safe to replay under one ID.
  if (error instanceof RuntimeRpcCallError) {
    return isRemoteCreateOutcomeUnknown(error)
  }
  return !(error instanceof Error && error.name === 'AbortError')
}

export function createAgentSessionCreateOperation(): AgentSessionCreateOperation {
  const clientOperationId = createAgentSessionOperationId()
  return {
    clientOperationId,
    async run(invoke) {
      let lastError: unknown
      for (let attempt = 0; attempt < MAX_AMBIGUOUS_CREATE_ATTEMPTS; attempt += 1) {
        try {
          return await invoke(clientOperationId)
        } catch (error) {
          lastError = error
          if (!isAmbiguousCreateFailure(error)) {
            throw error
          }
        }
      }
      throw lastError
    }
  }
}

export function withAgentSessionCreateOperationId(
  request: Omit<RuntimeCreateAgentSessionRequest, 'clientOperationId'>,
  clientOperationId: string
): RuntimeCreateAgentSessionRequest {
  return { ...request, clientOperationId }
}
