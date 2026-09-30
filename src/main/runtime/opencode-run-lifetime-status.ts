import { tokenizeCommandLine } from '../../shared/agent-command-line-entrypoint'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import { isOpenCodeRunCommand } from '../../shared/opencode-headless-command'

// Why: the pane foreground tracker's settle delay; the shell has exec'd the command by then.
export const OPENCODE_RUN_SETTLE_MS = 350
const SIGINT_EXIT_CODE = 130

type OpenCodeAgent = 'opencode' | 'opencode2'

type Dependencies = {
  /** Local PTYs only: SSH and WSL foregrounds cannot be read on this host. */
  isObservablePty(ptyId: string): boolean
  readForegroundProcessName(ptyId: string): Promise<string | null>
  readForegroundCommandLine(ptyId: string, foregroundProcess: string): Promise<string | null>
  /** `yieldsToHookSince`: the store drops this write once a hook reported the pane since then. */
  publish(ptyId: string, payload: ParsedAgentStatusPayload, yieldsToHookSince: number): void
  now(): number
}

type CommandState = {
  generation: number
  startedAt: number
  timer: ReturnType<typeof setTimeout> | null
  armed: OpenCodeAgent | null
}

/**
 * Reports `opencode run` from its own process lifetime: Working once the pane's foreground
 * command is an OpenCode `run`, Done when that command finishes. OpenCode 2's `run` loads no
 * plugin, so nothing else can say which pane it runs in.
 */
export class OpenCodeRunLifetimeStatus {
  private readonly commands = new Map<string, CommandState>()
  private nextGeneration = 0

  constructor(private readonly deps: Dependencies) {}

  onCommandStarted(ptyId: string): void {
    this.forgetPty(ptyId)
    if (!this.deps.isObservablePty(ptyId)) {
      return
    }
    const state: CommandState = {
      generation: ++this.nextGeneration,
      startedAt: this.deps.now(),
      timer: null,
      armed: null
    }
    state.timer = setTimeout(() => {
      state.timer = null
      void this.inspect(ptyId, state)
    }, OPENCODE_RUN_SETTLE_MS)
    this.commands.set(ptyId, state)
  }

  onCommandFinished(ptyId: string, exitCode: number | null): void {
    const state = this.commands.get(ptyId)
    this.forgetPty(ptyId)
    if (!state?.armed) {
      return
    }
    const payload = normalizeAgentStatusPayload({
      state: 'done',
      prompt: '',
      agentType: state.armed,
      ...(exitCode === SIGINT_EXIT_CODE ? { interrupted: true } : {})
    })
    if (payload) {
      this.deps.publish(ptyId, payload, state.startedAt)
    }
  }

  forgetPty(ptyId: string): void {
    const state = this.commands.get(ptyId)
    if (state?.timer) {
      clearTimeout(state.timer)
    }
    this.commands.delete(ptyId)
  }

  private isCurrent(ptyId: string, state: CommandState): boolean {
    return this.commands.get(ptyId)?.generation === state.generation
  }

  private async inspect(ptyId: string, state: CommandState): Promise<void> {
    try {
      const name = await this.deps.readForegroundProcessName(ptyId)
      const agent = recognizeAgentProcess(name)?.agent
      if (
        !name ||
        !this.isCurrent(ptyId, state) ||
        (agent !== 'opencode' && agent !== 'opencode2')
      ) {
        return
      }
      const tokens = tokenizeCommandLine(
        (await this.deps.readForegroundCommandLine(ptyId, name)) ?? ''
      )
      if (
        !this.isCurrent(ptyId, state) ||
        recognizeAgentProcess(tokens[0])?.agent !== agent ||
        !isOpenCodeRunCommand(tokens)
      ) {
        return
      }
      const payload = normalizeAgentStatusPayload({
        state: 'working',
        prompt: '',
        agentType: agent
      })
      if (!payload) {
        return
      }
      state.armed = agent
      this.deps.publish(ptyId, payload, state.startedAt)
    } catch {
      // Why: a failed read is missing evidence; the pane stays silent rather than guessed.
    }
  }
}
