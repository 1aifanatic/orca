import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import { getStructuredAgentSessionOutbox } from '@/components/native-chat/structured-agent-session-outbox-storage'
import {
  sendStructuredAgentSessionOutboxEntry,
  structuredAgentSessionSettlementEnding
} from '@/components/native-chat/structured-agent-session-outbox-dispatch'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import {
  watchStructuredAgentSessionEntryEnding,
  type StructuredAgentSessionEntryEnding
} from '@/components/native-chat/structured-agent-session-entry-endings'
import {
  shareStructuredAgentLaunchPromptDispatch,
  type StructuredAgentLaunchPromptDispatch
} from './structured-agent-launch-prompt-in-flight-dispatches'

export type StructuredPromptDeliveryResult = {
  delivered: boolean
  failureNotified: boolean
}

export type StructuredLaunchPromptOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready' | 'draft'
  onPromptDelivered?: () => void
}

type LaunchReceipt = { sessionId: string; fence: number }

/** The launch prompt goes out through the outbox's own sender and settlement, like any send. */
async function dispatchStructuredLaunchPrompt(
  staged: StructuredAgentSessionOutboxEntry,
  receipt: LaunchReceipt,
  target: RuntimeClientTarget
): StructuredAgentLaunchPromptDispatch {
  const entries = getStructuredAgentSessionOutbox(staged.sessionId)
  const entry = entries.find((candidate) => candidate.clientMessageId === staged.clientMessageId)
  // Gone or already out: whatever settled or sent it owns it.
  if (!entry || entry.state !== 'queued') {
    return null
  }
  return sendStructuredAgentSessionOutboxEntry({
    next: entry,
    entries,
    target,
    fence: receipt.fence,
    isCurrent: () => true
  })
}

export function settleStructuredAgentLaunchPrompt(args: {
  launchResult: Promise<LaunchReceipt>
  target: RuntimeClientTarget
  options: StructuredLaunchPromptOptions
  stagedEntry: StructuredAgentSessionOutboxEntry | null
}): Promise<StructuredPromptDeliveryResult> | undefined {
  // Why: a draft has no delivery event — the composer adopts it and the user sends it — so
  // `onPromptDelivered` never fires and no result is reported.
  if (args.options.promptDelivery === 'draft' || !args.options.prompt?.trim()) {
    return undefined
  }
  return args.launchResult.then(async (receipt) => {
    if (!args.stagedEntry) {
      return { delivered: false, failureNotified: true }
    }
    const entry = args.stagedEntry
    // Watched before it goes, so an answer that settles it at once is not missed.
    const watch = watchStructuredAgentSessionEntryEnding(entry.sessionId, entry.clientMessageId)
    const dispatch = shareStructuredAgentLaunchPromptDispatch(
      entry.sessionId,
      entry.clientMessageId,
      receipt.fence,
      () => dispatchStructuredLaunchPrompt(entry, receipt, args.target)
    )
    const settlement = await dispatch.promise
    const held = getStructuredAgentSessionOutbox(entry.sessionId).some(
      (candidate) => candidate.clientMessageId === entry.clientMessageId
    )
    const finish = (ending: StructuredAgentSessionEntryEnding): StructuredPromptDeliveryResult => {
      const delivered = ending === 'delivered'
      if (delivered) {
        args.options.onPromptDelivered?.()
      }
      // Not delivered, it came back to the chat's composer, which says why.
      return { delivered, failureNotified: !delivered }
    }
    if (!held && watch.endedAs() === null) {
      // It ended before this watched: the shared send's own answer, if it has one, says how.
      watch.cancel()
      const ending = settlement ? structuredAgentSessionSettlementEnding(settlement) : null
      // Otherwise nothing here sent it or can say how it ended.
      return ending ? finish(ending) : { delivered: false, failureNotified: false }
    }
    // With no answer yet the open chat keeps sending it, so this waits for how it finally ends,
    // never offering the prompt again while the chat may still deliver it.
    return finish(await watch.ending)
  })
}
