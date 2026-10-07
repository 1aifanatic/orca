import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { agentLaunchPaneNoticeText } from '@/components/terminal-pane/agent-launch-pane-notice-text'
import {
  launchAgentThroughHost,
  windowMakesHostLaunchTab,
  type HostAgentLaunchArgs,
  type HostAgentLaunchOutcome
} from '@/lib/agent-launch-through-host'
import { useAppStore } from '@/store'
import { createPasteReadinessTimeoutNotice } from '@/lib/launch-agent-paste-timeout-notice'
import { seedCommandCodeSubmittedPromptStatus } from '@/lib/command-code-prompt-status-seed'
import { isNativeChatSupportedAgent } from '@/lib/native-chat-supported-agent'
import type { AgentLaunchPromptReceipt } from '../../../shared/agent-launch-intent'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * Whether a new agent tab starts through the host's `agent.launch`: an AI button's launch, whose
 * prompt is pasted once the agent is ready, in a terminal this window makes. A typed prompt
 * (`auto-submit`, `draft`) keeps main's launch, and so does a launch the host could turn into a chat.
 */
export function newTabPromptLaunchesThroughHost(args: {
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  pastesPrompt: boolean
}): boolean {
  return (
    args.promptDelivery === 'submit-after-ready' && args.pastesPrompt && windowMakesHostLaunchTab()
  )
}

/** The tab is gone, so the pane's own words go in a notice, with its prompt to copy. */
function showLaunchNotStartedNotice(outcome: HostAgentLaunchOutcome, prompt: string): void {
  if (outcome.kind !== 'not-started') {
    return
  }
  toast.error(
    agentLaunchPaneNoticeText(
      outcome.unconfirmed
        ? { kind: 'unconfirmed' }
        : { kind: 'not-started', code: outcome.code ?? '' }
    ),
    {
      action: {
        label: translate(
          'auto.components.terminal.pane.AgentLaunchPaneNotice.copyPrompt',
          'Copy prompt'
        ),
        onClick: () => void window.api.ui.writeClipboardText(prompt)
      }
    }
  )
}

/** The chat view's copy of a submitted prompt, as main's paste seeds it at the launch. */
function seedChatCopy(tabId: string, agent: TuiAgent, text: string, createdAt: number): boolean {
  if (text.trim().length === 0 || !isNativeChatSupportedAgent(agent)) {
    return false
  }
  useAppStore.getState().seedNativeChatLaunchPrompt({ tabId, agent, text, createdAt })
  return true
}

/**
 * What the host's answer means for the click: the follow-ups run on a prompt it handed to the
 * agent, and a prompt it could not hand over gets main's own "wasn't sent" notice.
 */
function settleHostPrompt(
  args: HostAgentLaunchArgs & {
    onPromptDelivered?: () => void
    onPromptDeliveryUnconfirmed?: () => void
  },
  tabId: string,
  receipt: AgentLaunchPromptReceipt | undefined,
  seeded: boolean
): { delivered: boolean; failureNotified: boolean } {
  if (receipt?.outcome === 'handed-to-terminal') {
    if (receipt.composerUnobserved) {
      args.onPromptDeliveryUnconfirmed?.()
    }
    if (args.agent === 'command-code') {
      // Command Code has no prompt-submit hook; seed working when the prompt is submitted.
      seedCommandCodeSubmittedPromptStatus(args.worktreeId, tabId, args.prompt)
    }
    args.onPromptDelivered?.()
    return { delivered: true, failureNotified: false }
  }
  if (seeded) {
    useAppStore.getState().markNativeChatLaunchPromptFailed(tabId)
  }
  if (receipt?.outcome !== 'not-delivered') {
    // An unconfirmed or missing answer may have landed: anything that offers to send it again, here
    // or from the caller, would invite a second send. Reported as said, so the caller stays quiet.
    return { delivered: false, failureNotified: true }
  }
  const notice = createPasteReadinessTimeoutNotice({
    worktreeId: args.worktreeId,
    tabId,
    agent: args.agent,
    submitted: true
  })
  notice.onTimeout()
  return { delivered: false, failureNotified: notice.wasNotified() }
}

/**
 * Starts the agent through the host, which also pastes and submits the prompt once the agent is
 * ready, as main's window did, and answers how it went. The follow-ups run on that answer.
 */
export function launchNewTabPromptThroughHost(
  args: HostAgentLaunchArgs & {
    /** What is pasted, which can differ from the prompt the user wrote. */
    pasteContent: string
    onPromptDelivered?: () => void
    onPromptDeliveryUnconfirmed?: () => void
  }
): {
  tabId: string
  promptDeliveryResult: Promise<{ delivered: boolean; failureNotified: boolean }>
} {
  const {
    pasteContent,
    onPromptDelivered: _delivered,
    onPromptDeliveryUnconfirmed: _u,
    ...launch
  } = args
  const { tabId, outcome } = launchAgentThroughHost({ ...launch, hostPrompt: pasteContent })
  // Stamped at the click: the chat view matches the agent's turn to a copy made before it.
  const clickedAt = Date.now()
  const promptDeliveryResult = outcome.then((launched) => {
    if (launched.kind === 'started') {
      // Seeded once the host started the agent, as main's paste seeded it: a launch that never
      // started leaves no chat copy behind.
      const seeded = seedChatCopy(tabId, args.agent, pasteContent, clickedAt)
      return settleHostPrompt(args, tabId, launched.prompt, seeded)
    }
    // The pane, or this notice for a tab that went, already says why: never a second notice.
    showLaunchNotStartedNotice(launched, args.prompt)
    return { delivered: false, failureNotified: true }
  })
  return { tabId, promptDeliveryResult }
}
