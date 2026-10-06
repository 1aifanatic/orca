import { structuredAgentSessionSendBody } from '../../../shared/structured-agent-session-send-mutation'
import { handBackStructuredAgentSessionMessage } from '@/components/native-chat/structured-agent-session-message-hand-back'
import {
  dropStructuredAgentSessionSends,
  sendStructuredAgentSessionMessage
} from '@/components/native-chat/structured-agent-session-message-sender'
import { noteStructuredAgentSessionFence } from '@/components/native-chat/structured-agent-session-send-attempt'
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

/** A launch's text, held in memory from the click until its chat exists, then sent once: every
 *  caller waiting on it shares the one send. */
export type StagedStructuredLaunchPrompt = {
  sessionId: string
  text: string
  delivery?: Promise<boolean>
  /** Its launch was cancelled: never sent, never given back. */
  discarded?: true
  /** Settles once it is discarded, so its callers need not wait on a create that may never end. */
  whenDiscarded: Promise<void>
  discard: () => void
}

const staged = new Map<string, Set<StagedStructuredLaunchPrompt>>()

export function stageStructuredLaunchPrompt(
  sessionId: string,
  text: string
): StagedStructuredLaunchPrompt {
  let discard = (): void => {}
  const whenDiscarded = new Promise<void>((resolve) => {
    discard = resolve
  })
  const prompt: StagedStructuredLaunchPrompt = { sessionId, text, whenDiscarded, discard }
  const forSession = staged.get(sessionId) ?? new Set()
  forSession.add(prompt)
  staged.set(sessionId, forSession)
  return prompt
}

function unstage(prompt: StagedStructuredLaunchPrompt): void {
  const forSession = staged.get(prompt.sessionId)
  forSession?.delete(prompt)
  if (forSession?.size === 0) {
    staged.delete(prompt.sessionId)
  }
}

/** The launch was cancelled: what it staged is dropped with its chat. */
export function discardStructuredLaunchPrompts(sessionId: string): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    prompt.discarded = true
    prompt.discard()
  }
  staged.delete(sessionId)
}

/** The chat is closing or its launch was cancelled: nothing it was sending goes out any more. */
export function discardStructuredAgentSessionChatSends(sessionId: string): void {
  discardStructuredLaunchPrompts(sessionId)
  dropStructuredAgentSessionSends(sessionId)
}

/** Whether a launch still holds text for this chat that has not reached its host. */
export function hasStagedStructuredLaunchPrompt(sessionId: string): boolean {
  return (staged.get(sessionId)?.size ?? 0) > 0
}

function sendStagedPrompt(
  prompt: StagedStructuredLaunchPrompt,
  receipt: LaunchReceipt,
  target: RuntimeClientTarget
): Promise<boolean> {
  prompt.delivery ??= (async () => {
    noteStructuredAgentSessionFence(prompt.sessionId, receipt.fence)
    const sent = sendStructuredAgentSessionMessage({
      sessionId: prompt.sessionId,
      target,
      text: prompt.text
    })
    if (!sent) {
      // The person's own message went out first: the launch text waits in the composer instead.
      unstage(prompt)
      handBackStructuredAgentSessionMessage(
        prompt.sessionId,
        `launch-${prompt.sessionId}`,
        structuredAgentSessionSendBody(prompt.text, [])
      )
      return false
    }
    try {
      return (await sent.outcome) === 'recorded'
    } finally {
      unstage(prompt)
    }
  })()
  return prompt.delivery
}

export function settleStructuredAgentLaunchPrompt(args: {
  launchResult: Promise<LaunchReceipt>
  target: RuntimeClientTarget
  options: StructuredLaunchPromptOptions
  stagedPrompt: StagedStructuredLaunchPrompt | null
}): Promise<StructuredPromptDeliveryResult> | undefined {
  // Why: a draft has no delivery event — the composer adopts it and the user sends it — so
  // `onPromptDelivered` never fires and no result is reported.
  if (args.options.promptDelivery === 'draft' || !args.options.prompt?.trim()) {
    return undefined
  }
  const prompt = args.stagedPrompt
  const settled = args.launchResult.then(
    async (receipt) => {
      if (!prompt || prompt.discarded) {
        return { delivered: false, failureNotified: true }
      }
      const delivered = await sendStagedPrompt(prompt, receipt, args.target)
      if (delivered) {
        args.options.onPromptDelivered?.()
      }
      return { delivered, failureNotified: false }
    },
    (error: unknown) => {
      // The chat never started: its text waits in the chat's composer for the person's own Send.
      if (prompt && !prompt.discarded && !prompt.delivery) {
        unstage(prompt)
        prompt.discarded = true
        handBackStructuredAgentSessionMessage(
          prompt.sessionId,
          `launch-${prompt.sessionId}`,
          structuredAgentSessionSendBody(prompt.text, [])
        )
      }
      throw error
    }
  )
  if (!prompt || prompt.delivery) {
    return settled
  }
  const cancelled = prompt.whenDiscarded.then((): StructuredPromptDeliveryResult => ({
    delivered: false,
    failureNotified: true
  }))
  return Promise.race([settled, cancelled])
}
