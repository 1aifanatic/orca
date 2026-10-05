import { OrcaRuntimeWithAgentExitChatView } from './orca-runtime-agent-exit-chat-view'
import type { RuntimeTerminalSend } from '../../shared/runtime-types'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'
import type {
  RuntimeChatInputWriteResult,
  RuntimeTerminalWriteOptions
} from './runtime-terminal-writer'

/** Chat composer writes, fenced by the agent-exit guard and settled chunk by chunk. */
export class OrcaRuntimeWithNativeChatInput extends OrcaRuntimeWithAgentExitChatView {
  private readonly localChatInputTailByPtyId = new Map<string, Promise<unknown>>()

  /** A tagged chat write through `terminal.send`; refused writes never fall back to raw input. */
  protected async writeNativeChatInputAction(
    handle: string,
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    options: RuntimeTerminalWriteOptions & { chatInput: { actionId: string } }
  ): Promise<RuntimeTerminalSend> {
    const result = await this.terminalWriter.writeChatInputAction(ptyId, action, {
      ...options,
      admit: () =>
        this.nativeChatInputGuard.admit(
          ptyId,
          this.ptysById.get(ptyId)?.incarnationId ?? null,
          options.chatInput.actionId
        )
    })
    return { handle, ...result }
  }

  /**
   * The local desktop composer's write: the same guard and settled writer as `terminal.send`,
   * for local and SSH PTYs alike, serialized per PTY so a delayed Enter never overtakes its body.
   */
  writeNativeChatInputToPty(
    ptyId: string,
    data: string,
    inputKind: TerminalInputKind,
    actionId: string
  ): Promise<RuntimeChatInputWriteResult> {
    const previous = this.localChatInputTailByPtyId.get(ptyId) ?? Promise.resolve()
    const write = previous
      .catch(() => undefined)
      .then(() =>
        this.terminalWriter.writeChatInputAction(
          ptyId,
          { text: data },
          {
            inputKind,
            admit: () =>
              this.nativeChatInputGuard.admit(
                ptyId,
                this.ptysById.get(ptyId)?.incarnationId ?? null,
                actionId
              )
          }
        )
      )
    this.localChatInputTailByPtyId.set(ptyId, write)
    void write.finally(() => {
      if (this.localChatInputTailByPtyId.get(ptyId) === write) {
        this.localChatInputTailByPtyId.delete(ptyId)
      }
    })
    return write
  }
}
