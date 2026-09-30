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
import { discardStructuredAgentSessionLaunchOutbox } from '@/components/native-chat/structured-agent-session-outbox-storage'
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
  plan: AgentSessionLaunchPlan
  worktreeId: string
  tabId: string
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
    (candidate) => candidate.id === args.tabId
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
