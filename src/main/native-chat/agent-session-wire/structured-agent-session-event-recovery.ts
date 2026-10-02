import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { StructuredAgentSessionLifecycleEvent } from './structured-agent-session-adapter'
import { stopAgentSessionProviderRoot } from './structured-agent-session-provider-exit-proof'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionSinkBarrier } from './structured-agent-session-event-sink'
import { settleStructuredAgentSessionProviderStarted } from './structured-agent-session-provider-started'
import { settleUnexpectedStructuredAgentSessionExit } from './structured-agent-session-unexpected-exit'
import { endClosedStructuredAgentSessionChild } from './structured-agent-session-child-close'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'

export class StructuredAgentSessionEventRecovery {
  private readonly sinkFailures = new Set<string>()

  constructor(
    private readonly context: {
      deps: StructuredAgentSessionHostDeps
      store: StructuredAgentSessionHostDeps['store']
      sessions: Map<string, StructuredAgentSessionHostSession>
      flushLifecycle: (sessionId: string) => Promise<StructuredAgentSessionSinkBarrier>
      publishFence: (sessionId: string, session: StructuredAgentSessionHostSession) => void
      publishStatus?: (sessionId: string) => void
      serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
      now: () => number
      /** Where a close the host asked for ends the child's record. */
      lifetime: () => StructuredAgentSessionLifetimeContext
    }
  ) {}

  private get exitContext() {
    return {
      ...this.context,
      logger: this.context.deps.logger,
      wakeDelivery: this.context.lifetime().wakeDelivery
    }
  }

  recoverAfterSinkFailure(sessionId: string, error: unknown): void {
    if (this.sinkFailures.has(sessionId)) {
      return
    }
    this.sinkFailures.add(sessionId)
    void this.context
      .serialize(sessionId, async () => {
        const child = this.context.sessions.get(sessionId)?.child
        const stop =
          this.context.deps.adapter.forceCloseSession ?? this.context.deps.adapter.closeSession
        if (!child || !stop) {
          return null
        }
        const { fence, generation: acquisitionGeneration } = child
        const stopped = await stopAgentSessionProviderRoot(() => stop(sessionId))
        if (!stopped || !acquisitionGeneration) {
          return null
        }
        return {
          type: 'ended',
          sessionId,
          reason: `journal sink failure: ${error instanceof Error ? error.message : String(error)}`,
          // Orca stopped the provider because its own journal failed.
          failure: agentSessionFailureFact('hostFault'),
          cause: 'unexpected-exit',
          fence,
          acquisitionGeneration
        } as const
      })
      .then((event) => (event ? this.handle(event) : undefined))
      .catch((error: unknown) =>
        this.context.deps.logger.warn(
          'stopping a provider after its journal failed did not finish',
          {
            scope: 'sink-failure-recovery',
            sessionId,
            error
          }
        )
      )
      .finally(() => this.sinkFailures.delete(sessionId))
  }

  /** Every child's exit ends its record here, expected or not. An exit is settled and shown;
   *  nothing restarts the child. The next send does, through the delivery loop, which also owns any
   *  message still queued. */
  async handle(event: StructuredAgentSessionLifecycleEvent): Promise<void> {
    if (event.type === 'started') {
      return settleStructuredAgentSessionProviderStarted(this.context, event)
    }
    if (event.cause === 'requested-close') {
      return endClosedStructuredAgentSessionChild(this.context.lifetime(), event)
    }
    await settleUnexpectedStructuredAgentSessionExit(this.exitContext, event)
  }
}
