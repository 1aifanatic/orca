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
import type { AgentLaunchFollowUp } from '../../../shared/agent-launch-follow-up'
import { recordableLaunchFollowUp, takeLaunchFollowUps } from '@/lib/agent-launch-follow-ups'
import { waitForRecordedLaunchFollowUp } from '@/lib/agent-launch-follow-up-waiter'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { desktopNewTabPromptDelivery } from '../../../shared/desktop-new-tab-prompt'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type {
  LaunchAgentInNewTabArgs,
  LaunchAgentInNewTabResult
} from './launch-agent-in-new-tab-contract'

/** `followUpDeferred`: the click's recorded follow-up was left for the next start; don't run it. */
export type NewTabPromptDeliveryResult = {
  delivered: boolean
  failureNotified: boolean
  followUpDeferred?: boolean
}

/** Existing AI buttons retain their submit-after-ready paste transport. */
export function newTabPromptLaunchesThroughHost(args: {
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  pastesPrompt: boolean
}): boolean {
  return (
    args.promptDelivery === 'submit-after-ready' && args.pastesPrompt && windowMakesHostLaunchTab()
  )
}

/** Chat-default fallbacks keep their already-decided renderer surface. */
export function newTabTerminalLaunchesThroughHost(): boolean {
  return windowMakesHostLaunchTab()
}

/** Keeps fresh desktop startup and live input on the existing reserved-pane launch. */
export function launchFreshTerminalTabThroughHost(
  args: LaunchAgentInNewTabArgs,
  startupPlan: AgentStartupPlan,
  pasteDraftAfterLaunch: string | null
): NonNullable<LaunchAgentInNewTabResult> {
  const prompt = args.prompt?.trim() ?? ''
  const promptDelivery = args.promptDelivery ?? 'auto-submit'
  const launched = launchNewTabPromptThroughHost({
    agent: args.agent,
    worktreeId: args.worktreeId,
    groupId: args.groupId,
    prompt,
    pasteContent: prompt,
    desktopPrompt: {
      text: prompt,
      delivery: desktopNewTabPromptDelivery(args.agent, promptDelivery),
      transport: { kind: 'desktop-new-tab', promptDelivery }
    },
    seedSubmittedChatCopy: pasteDraftAfterLaunch !== null,
    ...(args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {}),
    ...(args.initialCwd?.trim() ? { cwd: args.initialCwd } : {}),
    launchSource: args.launchSource ?? 'tab_bar_quick_launch',
    quickCommandLabel: args.quickCommandLabel,
    pendingActivationSpawn: args.pendingActivationSpawn,
    activate: args.activate,
    ...(args.onPromptDelivered ? { onPromptDelivered: args.onPromptDelivered } : {}),
    ...(args.onPromptDeliveryUnconfirmed
      ? { onPromptDeliveryUnconfirmed: args.onPromptDeliveryUnconfirmed }
      : {})
  })
  if (prompt && promptDelivery !== 'submit-after-ready') {
    void launched.promptDeliveryResult.catch((error) =>
      console.error('Prompt delivery failed after launch', error)
    )
  }
  return {
    surface: { kind: 'local-terminal', tabId: launched.tabId },
    startupPlan,
    pasteDraftAfterLaunch: pasteDraftAfterLaunch !== null,
    ...(prompt && promptDelivery === 'submit-after-ready'
      ? { promptDeliveryResult: launched.promptDeliveryResult }
      : {})
  }
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
async function settleHostPrompt(
  args: HostAgentLaunchArgs & {
    onPromptDelivered?: () => void
    onPromptDeliveryUnconfirmed?: () => void
  },
  launch: { tabId: string; operationId: string; followUp: AgentLaunchFollowUp | undefined },
  receipt: AgentLaunchPromptReceipt | undefined,
  seeded: boolean
): Promise<NewTabPromptDeliveryResult> {
  const { tabId } = launch
  // Runs here only when this click's own take returned it; one another take returned runs there.
  let followUpRunsHere = true
  let stillRecorded: { deadline?: number } | null = null
  if (launch.followUp) {
    const take = await takeLaunchFollowUps(launch.operationId)
    const mine = (entry: { operationId: string }): boolean =>
      entry.operationId === launch.operationId
    followUpRunsHere = take?.taken.some((entry) => mine(entry) && entry.promptHandedOver) ?? false
    stillRecorded = take ? (take.pending.find(mine) ?? null) : {}
  }
  if (receipt?.outcome === 'handed-to-terminal') {
    if (receipt.composerUnobserved) {
      args.onPromptDeliveryUnconfirmed?.()
    }
    if (args.agent === 'command-code' && args.desktopPrompt?.delivery !== 'draft') {
      // Command Code has no prompt-submit hook; seed working when the prompt is submitted.
      seedCommandCodeSubmittedPromptStatus(args.worktreeId, tabId, args.prompt)
    }
    if (!followUpRunsHere) {
      if (launch.followUp && stillRecorded) {
        // The take failed, or the host has not settled the record: hold what it acts on, and take
        // it when the host says so, as a reloaded window would.
        void waitForRecordedLaunchFollowUp(
          launch.operationId,
          launch.followUp,
          stillRecorded.deadline
        )
      }
      return { delivered: true, failureNotified: false, followUpDeferred: true }
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
    submitted: args.desktopPrompt?.delivery !== 'draft'
  })
  notice.onTimeout()
  return { delivered: false, failureNotified: notice.wasNotified() }
}

/** Starts the reserved-pane launch and applies its actual prompt receipt to the click. */
export function launchNewTabPromptThroughHost(
  args: HostAgentLaunchArgs & {
    /** What is pasted, which can differ from the prompt the user wrote. */
    pasteContent: string
    /** Startup-carried submissions have no pasted chat bubble on main. */
    seedSubmittedChatCopy?: boolean
    onPromptDelivered?: () => void
    onPromptDeliveryUnconfirmed?: () => void
    /** What `onPromptDelivered` does, recorded so a reload mid-launch still runs it once. */
    durableFollowUp?: AgentLaunchFollowUp
  }
): {
  tabId: string
  promptDeliveryResult: Promise<{ delivered: boolean; failureNotified: boolean }>
} {
  const {
    pasteContent,
    onPromptDelivered: _delivered,
    onPromptDeliveryUnconfirmed: _u,
    durableFollowUp,
    seedSubmittedChatCopy = true,
    ...launch
  } = args
  const followUp = recordableLaunchFollowUp(durableFollowUp)
  const { tabId, operationId, outcome } = launchAgentThroughHost({
    ...launch,
    hostPrompt: pasteContent,
    ...(followUp ? { followUp } : {})
  })
  // Stamped at the click: the chat view matches the agent's turn to a copy made before it.
  const clickedAt = Date.now()
  if (args.desktopPrompt?.delivery === 'draft') {
    seedNativeChatLaunchDraftForAgentTab({ tabId, agent: args.agent, text: pasteContent })
  }
  const promptDeliveryResult = outcome.then((launched) => {
    if (launched.kind === 'started') {
      if (args.desktopPrompt && !args.desktopPrompt.text.trim()) {
        return { delivered: false, failureNotified: false }
      }
      // Seeded once the host started the agent, as main's paste seeded it: a launch that never
      // started leaves no chat copy behind.
      const seeded =
        seedSubmittedChatCopy &&
        args.desktopPrompt?.delivery !== 'draft' &&
        seedChatCopy(tabId, args.agent, pasteContent, clickedAt)
      return settleHostPrompt(args, { tabId, operationId, followUp }, launched.prompt, seeded)
    }
    // The pane, or this notice for a tab that went, already says why: never a second notice.
    showLaunchNotStartedNotice(launched, args.prompt)
    return { delivered: false, failureNotified: true }
  })
  return { tabId, promptDeliveryResult }
}
