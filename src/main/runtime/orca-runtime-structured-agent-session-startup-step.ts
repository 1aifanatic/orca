// The structured-chat startup step on the runtime: the host build, then the lease check, seed and
// settle, once per launch, and the history restore the tab restore owes once a listing has answered.

import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport } from './orca-runtime-get-structured-agent-session-create-support'
import { runStructuredAgentSessionStartup } from './structured-agent-session-startup-step'

export class OrcaRuntimeWithStructuredAgentSessionStartupStep extends OrcaRuntimeWithGetStructuredAgentSessionCreateSupport {
  // The history restore a tab restore owes, until a caller that answered with its list starts it.
  protected owedStructuredAgentSessionHistoryRestore: (() => void) | null = null
  // Listed chats startup could not answer from stored state; null until it has run.
  protected structuredAgentSessionBackgroundRestoreIds: string[] | null = null
  protected structuredAgentSessionStartupStepPromise: Promise<void> | null = null
  private readonly structuredAgentSessionStartupLogger = createStructuredAgentSessionLogger()

  /** Starts the history restore the tab restore owes, once. On the next macrotask, so a caller that
   *  starts it as it answers has sent that answer first. */
  startStructuredAgentSessionHistoryRestore(): void {
    const owed = this.owedStructuredAgentSessionHistoryRestore
    this.owedStructuredAgentSessionHistoryRestore = null
    if (owed) {
      setImmediate(owed)
    }
  }

  /** The tab restore's preparation: the startup step, then the terminal records refresh, which
   *  lists the daemon's terminals against the records the host build brought in. */
  prepareStructuredAgentSessionStartupRestoration(): Promise<void> {
    this.structuredAgentSessionStartupRestorePromise ??= this.startStructuredAgentSessionStartup()
      .then(async () => {
        if (this.hasPersistedStructuredAgentSessionStore()) {
          await this.refreshMobileSessionPtyRecords()
        }
      })
      .catch((error) => {
        this.structuredAgentSessionStartupRestorePromise = null
        throw error
      })
    return this.structuredAgentSessionStartupRestorePromise
  }

  /**
   * Desktop launch. The step needs neither the terminal daemon nor the hook server (structured
   * chats never run in WSL, the lease check probes processes, and the seed publishes in process),
   * so only the shell PATH is awaited, as before: the host build sets up the agents' launch
   * environments from it. Off Windows it is already resolved.
   */
  startStructuredAgentSessionStartupAfter(shellPathReady: Promise<unknown>): void {
    void shellPathReady
      .then(() => this.startStructuredAgentSessionStartup())
      .catch(this.reportStructuredAgentSessionStartupFailure)
  }

  /** `prepare` once `after` resolves, its failure reported rather than thrown: desktop runs it once
   *  the first window's services are up or timed out, orcad at once. */
  prepareStructuredAgentSessionStartupRestorationAfter(after: Promise<unknown>): void {
    void after
      .then(() => this.prepareStructuredAgentSessionStartupRestoration())
      .catch(this.reportStructuredAgentSessionStartupFailure)
  }

  /** A failed host build or seed at launch: in the diagnostics trace, not only the console. */
  private reportStructuredAgentSessionStartupFailure = (error: unknown): void => {
    this.structuredAgentSessionStartupLogger.warn('the chat startup step failed', {
      scope: 'startup-step-failed',
      error
    })
  }

  /** The host's startup step, once: the host build, then the lease check, seed and settle. */
  startStructuredAgentSessionStartup(): Promise<void> {
    this.structuredAgentSessionStartupStepPromise ??=
      this.startStructuredAgentSessionStartupOnce().catch((error) => {
        this.structuredAgentSessionStartupStepPromise = null
        throw error
      })
    return this.structuredAgentSessionStartupStepPromise
  }

  protected async startStructuredAgentSessionStartupOnce(): Promise<void> {
    const background = await runStructuredAgentSessionStartup({
      gate: this.structuredAgentSessionStartupGate,
      hasChatsOnDisk: () => this.hasPersistedStructuredAgentSessionStore(),
      buildHost: () => this.ensureStructuredAgentSessionHost(),
      savedSession: () => this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID) ?? null
    })
    if (background) {
      this.structuredAgentSessionBackgroundRestoreIds = background
    }
  }
}
