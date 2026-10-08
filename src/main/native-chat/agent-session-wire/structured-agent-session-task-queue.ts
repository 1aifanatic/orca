import { runKeyedSerializedOperation } from '../../cli/keyed-promise-queue'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'

export class StructuredAgentSessionTaskQueue {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly attaching = new Set<Promise<unknown>>()
  private admissionClosed = false

  serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    if (this.admissionClosed) {
      return Promise.reject(
        agentSessionRefusalError('agent_session_ownership_unknown', {
          reason: 'sessionNotAttached'
        })
      )
    }
    return this.serializeDuringShutdown(sessionId, task)
  }

  serializeDuringShutdown<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    return runKeyedSerializedOperation(this.chains, sessionId, task)
  }

  hasPending = (): boolean => this.chains.size > 0 || this.attaching.size > 0
  closeAdmission = (): void => {
    this.admissionClosed = true
  }

  trackAttach<T>(operation: Promise<T>): Promise<T> {
    this.attaching.add(operation)
    void operation.then(
      () => this.attaching.delete(operation),
      () => this.attaching.delete(operation)
    )
    return operation
  }

  async drainAttaches(): Promise<void> {
    while (this.attaching.size > 0) {
      await Promise.allSettled(this.attaching)
    }
  }
}
