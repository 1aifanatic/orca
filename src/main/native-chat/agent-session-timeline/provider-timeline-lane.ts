import { setTimeout as delay } from 'node:timers/promises'
import { StructuredAgentSessionTaskQueue } from '../agent-session-wire/structured-agent-session-task-queue'
import {
  createProviderTimelineAssembler,
  type ProviderTimelineAssemblerDeps
} from './provider-timeline-assembler'
import type { ProviderTimelineEvent } from './provider-timeline-event'
import { AgentSessionAcquisitionRefusal } from '../agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../agent-session-wire/structured-agent-session-event-sink'
import { providerTimelineSink } from './provider-timeline-plan'

/** HTTP streams await admission, retaining one frame while the journal drains. */
export class ProviderTimelineLane {
  readonly assembler
  private readonly tasks = new StructuredAgentSessionTaskQueue()
  private paused = false
  private readonly unbind: (() => void) | undefined

  constructor(
    private readonly deps: Omit<ProviderTimelineAssemblerDeps, 'sink'> & {
      sink: StructuredAgentSessionEventSink
      signal: AbortSignal
    }
  ) {
    const sink = providerTimelineSink(deps.sink)
    if (!sink) {
      throw new Error('Provider timeline requires a transition sink')
    }
    this.assembler = createProviderTimelineAssembler({ ...deps, sink })
    this.unbind = deps.sink.bindReadingControl?.({
      pauseReading: () => {
        this.paused = true
      },
      resumeReading: () => {
        this.paused = false
      }
    })
  }

  apply(events: readonly ProviderTimelineEvent[], restoring = false): Promise<void> {
    return this.tasks.serialize('events', async () => {
      for (const event of events) {
        for (;;) {
          this.deps.signal.throwIfAborted()
          if (this.paused && !restoring) {
            await delay(250, undefined, { signal: this.deps.signal })
            continue
          }
          const { admission } = this.assembler.apply(event)
          if (admission.accepted) {
            break
          }
          if (admission.reason !== 'backpressure') {
            throw new Error(`Provider timeline sink ${admission.reason}`)
          }
          if (restoring) {
            throw AgentSessionAcquisitionRefusal.historyTooLarge(
              'Provider history exceeds the bounded restore queue'
            )
          }
          await delay(250, undefined, { signal: this.deps.signal })
        }
      }
    })
  }

  dispose(): void {
    this.unbind?.()
    this.assembler.dispose()
  }
}
