import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-inspection'
import { TerminalSendAcknowledgmentUnavailableError } from '../../../../shared/terminal-send-acknowledgment'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { enqueueNativeChatPtySend } from './native-chat-pty-send-queue'
import {
  clearConfirmDurationMs,
  clearThenWrite,
  clearUnsubmittedAgentInput,
  type NativeChatSendOptions
} from './native-chat-input-clear'

/** Observe write refusals without mistaking transport success for provider acceptance. */
export function sendNativeChatObservedWrites(
  settings: ReturnType<typeof getSettingsForAgentTabRuntimeOwner>,
  ptyId: string,
  writes: readonly { data: string; delayBeforeMs: number }[],
  options: NativeChatSendOptions & { stopOnUnconfirmed?: boolean; settleDelayMs?: number }
) {
  return enqueueNativeChatPtySend(
    ptyId,
    writes.reduce((total, write) => total + write.delayBeforeMs, 0) +
      clearConfirmDurationMs(options) +
      (options.settleDelayMs ?? 0),
    ({ isCancelled, delay, markSubmitted }) => {
      let reportedUnconfirmed = false
      let acknowledged = true
      const writeAt = (index: number): void => {
        if (isCancelled()) {
          return
        }
        const write = writes[index]
        if (!write) {
          const finish = (): void => {
            options.onDeliverySettled?.(acknowledged)
            markSubmitted()
          }
          if (options.settleDelayMs) {
            delay(options.settleDelayMs, finish)
          } else {
            finish()
          }
          return
        }
        const send = (): void => {
          if (isCancelled()) {
            return
          }
          void sendRuntimePtyInputVerified(settings, ptyId, write.data, 'driving')
            .then((accepted) => {
              if (isCancelled()) {
                return
              }
              if (!accepted) {
                options.onWriteRejected?.()
                options.onDeliverySettled?.(false)
                markSubmitted()
                return
              }
              writeAt(index + 1)
            })
            // Legacy handoff can advance the sequence without acknowledging the answer.
            .catch((error) => {
              if (isCancelled()) {
                return
              }
              acknowledged = false
              if (!reportedUnconfirmed) {
                reportedUnconfirmed = true
                options.onWriteUnconfirmed?.()
              }
              if (
                options.stopOnUnconfirmed &&
                !(
                  error instanceof TerminalSendAcknowledgmentUnavailableError &&
                  error.legacyHandoffCompleted
                )
              ) {
                options.onDeliverySettled?.(false)
                markSubmitted()
                return
              }
              writeAt(index + 1)
            })
        }
        if (write.delayBeforeMs > 0) {
          delay(write.delayBeforeMs, send)
        } else {
          send()
        }
      }
      clearThenWrite(settings, ptyId, options, delay, () => writeAt(0))
    },
    { onCancelUnsubmitted: () => clearUnsubmittedAgentInput(settings, ptyId, options) }
  )
}
