import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  abandonStructuredAgentSessionLaunchIntent,
  StructuredAgentSessionHostDeclinedError,
  StructuredAgentSessionHostUnreachableError
} from '@/lib/launch-structured-agent-session'
import {
  deleteStructuredLaunchStateIfCurrent,
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchListeners
} from '@/lib/structured-agent-session-launch-registry'
import {
  discardStructuredAgentSessionLaunchOutbox,
  readOutbox
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import { retryStructuredAgentSessionLaunch } from '@/lib/structured-agent-session-launch'
import { clearStructuredAgentLaunchDraft } from '@/lib/structured-agent-session-launch-draft'
import {
  adoptAgentSessionLaunchVerdict,
  type AgentSessionLaunchPlan
} from '@/lib/agent-session-launch-plan'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'

/** A launch the host settled before anything was created leaves nothing to retry or cancel. */
function forgetUnstartedStructuredAgentLaunch(sessionId: string): void {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state) {
    return
  }
  discardStructuredAgentSessionLaunchOutbox(sessionId)
  clearStructuredAgentLaunchDraft(sessionId)
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  if (deleteStructuredLaunchStateIfCurrent(state)) {
    notifyStructuredLaunchListeners()
  }
}

/**
 * A chat tab whose launch settled before anything was created has nothing to show or retry, so it
 * closes: a declining paired server's workspace gets its terminal with a notice saying why, and an
 * unreachable host leaves the failure toast alone.
 */
export function replaceUnstartedStructuredChat(args: {
  /** What the chat was launched with, which its replacement terminal is launched with too. */
  plan: Pick<AgentSessionLaunchPlan, 'agent' | 'prompt' | 'promptDelivery' | 'onPromptDelivered'>
  worktreeId: string
  sessionId: string
  error: unknown
}): void {
  const fallsBack =
    args.error instanceof StructuredAgentSessionHostDeclinedError && args.error.opensTerminal
  if (!fallsBack && !(args.error instanceof StructuredAgentSessionHostUnreachableError)) {
    return
  }
  forgetUnstartedStructuredAgentLaunch(args.sessionId)
  const state = useAppStore.getState()
  const tab = (state.unifiedTabsByWorktree[args.worktreeId] ?? []).find(
    (candidate) =>
      candidate.contentType === 'agent-session' && candidate.entityId === args.sessionId
  )
  if (!tab) {
    return
  }
  state.closeUnifiedTab(tab.id)
  if (!fallsBack || (args.plan.agent !== 'claude' && args.plan.agent !== 'codex')) {
    return
  }
  const agentLabel = structuredAgentLabel(args.plan.agent)
  toast.info(
    translate(
      'components.native-chat.structuredSessionHostDeclined',
      'Opened {{value0}} in a terminal',
      {
        value0: agentLabel
      }
    ),
    {
      description: translate(
        'components.native-chat.structuredSessionHostDeclinedDescription',
        "This server can't run a {{value0}} chat in this workspace.",
        { value0: agentLabel }
      )
    }
  )
  // Loaded late: the new-tab launcher opens this module's provisional tabs.
  void import('@/lib/launch-agent-in-new-tab').then(({ launchAgentInNewTab }) =>
    launchAgentInNewTab({
      agent: args.plan.agent,
      worktreeId: args.worktreeId,
      groupId: tab.groupId,
      ...(args.plan.prompt ? { prompt: args.plan.prompt } : {}),
      ...(args.plan.promptDelivery ? { promptDelivery: args.plan.promptDelivery } : {}),
      ...(args.plan.onPromptDelivered ? { onPromptDelivered: args.plan.onPromptDelivered } : {}),
      agentSessionLaunchPlan: adoptAgentSessionLaunchVerdict({
        route: 'terminal-tui',
        agent: args.plan.agent,
        worktreeId: args.worktreeId
      })
    })
  )
}

/**
 * Retries a chat's launch. A launch restored after a reload has no first-launch settlement to hand
 * a pre-create failure on, so the retry's own does: a declining paired server opens its terminal
 * here too, carrying the prompt the launch had staged.
 */
export function retryStructuredChatLaunch(worktreeId: string, sessionId: string): boolean {
  if (!retryStructuredAgentSessionLaunch(worktreeId, sessionId)) {
    return false
  }
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state) {
    return true
  }
  const prompt = readOutbox(sessionId)
    .find((entry) => entry.source === 'launch')
    ?.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
  const plan = {
    agent: state.intent.agent,
    ...(prompt ? { prompt, promptDelivery: 'auto-submit' as const } : {})
  }
  void state.promise.catch((error: unknown) =>
    replaceUnstartedStructuredChat({
      plan,
      worktreeId,
      sessionId,
      error
    })
  )
  return true
}
