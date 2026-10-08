import { randomUUID } from 'node:crypto'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type {
  AgentSessionOptionsResult,
  AgentSessionSlashCommand
} from '../../shared/agent-session-wire'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { piRpcProviderLink, type PiRpcResolvedLaunch } from './rpc-launch-resolution'
import {
  applyPiRpcSessionOption,
  piModelOptionId,
  readPiRpcCommands,
  readPiRpcSessionOptions
} from './rpc-options'
import { piRpcStateSchema, type PiRpcState } from './rpc-protocol'
import type { PiRpcConnection, PiRpcSessionDeps } from './rpc-session'

export class PiRpcSessionStartup {
  started = false
  answered = false
  commands?: AgentSessionSlashCommand[]
  private readonly controller = new AbortController()

  constructor(
    private readonly input: StructuredAgentSessionAcquireInput,
    private readonly generation: string,
    private readonly connection: PiRpcConnection,
    private readonly selected: Map<string, string>,
    private readonly deps: PiRpcSessionDeps,
    private readonly setState: (state: PiRpcState) => void
  ) {}

  stop(): void {
    this.controller.abort(new Error('Pi closed while starting'))
  }

  async run(launch: PiRpcResolvedLaunch): Promise<void> {
    const optionRevision = this.input.optionRevision?.() ?? 0
    const answer = await this.wait(this.connection.request('get_state'))
    this.answered = true
    this.assertLive()
    const state = piRpcStateSchema.parse(answer)
    const link = piRpcProviderLink(
      launch,
      state.sessionFile,
      this.input.fence,
      randomUUID(),
      Date.now()
    )
    this.setState(state)
    const current: AgentSessionOptionsResult['current'] = {
      model: state.model ? piModelOptionId(state.model.provider, state.model.id) : '',
      ...(state.thinkingLevel ? { effort: state.thinkingLevel } : {})
    }
    const saved = this.input.options ?? {}
    const skipped = Object.keys(saved).filter((key) => key !== 'model' && key !== 'effort')
    for (const key of ['model', 'effort'] as const) {
      const value = saved[key]
      if (value === undefined) {
        continue
      }
      try {
        this.assertLive()
        await this.wait(applyPiRpcSessionOption(this.connection, this.selected, key, value))
        current[key] = value
      } catch (error) {
        if (!(error instanceof JsonlRpcResponseError)) {
          throw error
        }
        skipped.push(key)
        this.warn('Pi rejected a saved option', 'pi-option-restore', error, { key })
      }
    }
    this.assertLive()
    current.confirmed = [...(current.model ? ['model'] : []), ...(current.effort ? ['effort'] : [])]
    this.started = true
    this.deps.onLifecycle({
      type: 'started',
      ...this.identity(),
      link,
      reportedOptions: current,
      restoreSkippedOptions: skipped,
      optionRevision
    })
    await Promise.all([this.readOptions(skipped), this.readCommands()])
  }

  private async readOptions(restoreSkippedOptions: readonly string[]): Promise<void> {
    const optionRevision = this.input.optionRevision?.() ?? 0
    try {
      this.assertLive()
      const options = await this.wait(readPiRpcSessionOptions(this.connection))
      this.assertLive()
      this.deps.onLifecycle({
        type: 'options-reported',
        ...this.identity(),
        reportedOptions: options.current,
        restoreSkippedOptions,
        optionRevision
      })
    } catch (error) {
      this.warn('Pi options could not be read', 'pi-options', error)
    }
  }

  private async readCommands(): Promise<void> {
    try {
      this.assertLive()
      const result = await this.wait(readPiRpcCommands(this.connection))
      this.assertLive()
      this.commands = result.commands
    } catch (error) {
      this.warn('Pi commands could not be read', 'pi-commands', error)
    }
  }

  private assertLive(): void {
    if (this.controller.signal.aborted || this.connection.closed) {
      throw new Error('Pi closed while starting')
    }
  }

  private wait<T>(promise: Promise<T>): Promise<T> {
    return waitForPromiseWithSignal(promise, this.controller.signal)
  }

  private identity() {
    return {
      sessionId: this.input.identity.sessionId,
      fence: this.input.fence,
      acquisitionGeneration: this.generation
    }
  }

  private warn(message: string, scope: string, error: unknown, fields = {}): void {
    if (!this.controller.signal.aborted) {
      this.deps.logger.warn(message, {
        scope,
        sessionId: this.input.identity.sessionId,
        error,
        ...fields
      })
    }
  }
}
