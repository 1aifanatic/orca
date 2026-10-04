import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import type { StructuredAgentSessionSendSettlement } from '../../../shared/structured-agent-session-send-settlement'
import { getStructuredAgentSessionOutbox } from '@/components/native-chat/structured-agent-session-outbox-storage'
import { sendStructuredAgentSessionOutboxEntry } from '@/components/native-chat/structured-agent-session-outbox-dispatch'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

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

/** How the send settled, or null when nothing was sent. */
type SharedDispatch = Promise<StructuredAgentSessionSendSettlement | null>

type SharedDispatchStart = {
  promise: SharedDispatch
  started: boolean
}

// A provisional chat can mount before its launch settlement runs. Both paths own the same
// persisted entry, so share the in-flight admission by operation id instead of issuing two RPCs.
const inFlightDispatches = new Map<string, SharedDispatch>()

function dispatchKey(sessionId: string, clientMessageId: string, fence: number): string {
  return `${sessionId}:${clientMessageId}:${fence}`
}

export function getStructuredAgentLaunchPromptDispatch(
  sessionId: string,
  clientMessageId: string,
  fence?: number
): SharedDispatch | undefined {
  if (fence !== undefined) {
    return inFlightDispatches.get(dispatchKey(sessionId, clientMessageId, fence))
  }
  const prefix = `${sessionId}:${clientMessageId}:`
  for (const [key, promise] of inFlightDispatches) {
    if (key.startsWith(prefix)) {
      return promise
    }
  }
  return undefined
}

export function shareStructuredAgentLaunchPromptDispatch(
  sessionId: string,
  clientMessageId: string,
  fence: number,
  start: () => SharedDispatch
): SharedDispatchStart {
  const key = dispatchKey(sessionId, clientMessageId, fence)
  const existing = inFlightDispatches.get(key)
  if (existing) {
    return { promise: existing, started: false }
  }
  const promise = Promise.resolve().then(start)
  inFlightDispatches.set(key, promise)
  const clear = (): void => {
    if (inFlightDispatches.get(key) === promise) {
      inFlightDispatches.delete(key)
    }
  }
  void promise.then(clear, clear)
  return { promise, started: true }
}

/** The launch prompt goes out through the outbox's own sender and settlement, like any send. */
async function dispatchStructuredLaunchPrompt(
  staged: StructuredAgentSessionOutboxEntry,
  receipt: LaunchReceipt,
  target: RuntimeClientTarget
): SharedDispatch {
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
    const dispatch = shareStructuredAgentLaunchPromptDispatch(
      entry.sessionId,
      entry.clientMessageId,
      receipt.fence,
      () => dispatchStructuredLaunchPrompt(entry, receipt, args.target)
    )
    const settlement = await dispatch.promise
    const delivered = settlement?.kind === 'recorded' || settlement?.kind === 'pending'
    if (delivered) {
      args.options.onPromptDelivered?.()
    }
    // Once sent, the chat holds the prompt: it says why it came back, or keeps sending it, so the
    // caller must not offer it again beside the chat.
    return { delivered, failureNotified: !delivered && settlement !== null }
  })
}
