import type { ActiveAgentNotesSendResult } from './active-agent-note-send-result'
import type { AgentMessageTarget } from './agent-message-target'
import { sendNotesToActiveAgentSession } from './active-agent-note-send'
import { relaunchFailedStructuredAgentSessionForMessage } from './structured-agent-session-launch'
import { sendStructuredAgentSessionMessage } from '@/components/native-chat/structured-agent-session-message-sender'
import { structuredAgentSessionTargetForTab } from '@/runtime/structured-agent-session-owner'
import { useAppStore } from '@/store'

export type { AgentMessageTarget } from './agent-message-target'

/** The one way a picked agent is sent a message, whatever transport it runs on. */
export async function sendMessageToAgent(args: {
  worktreeId: string
  target: AgentMessageTarget
  prompt: string
}): Promise<ActiveAgentNotesSendResult> {
  const { target, worktreeId } = args
  const prompt = args.prompt.trim()
  if (!prompt) {
    return { status: 'empty', code: 'empty' }
  }
  if (target.kind === 'terminal') {
    return sendNotesToActiveAgentSession({
      worktreeId,
      prompt,
      noteTarget: { tabId: target.tabId, leafId: target.leafId }
    })
  }
  const state = useAppStore.getState()
  const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) =>
      candidate.contentType === 'agent-session' && candidate.entityId === target.sessionId
  )
  const runtime = tab ? structuredAgentSessionTargetForTab(state, tab) : null
  if (!runtime) {
    return { status: 'not-writable', code: 'session-send-refused' }
  }
  relaunchFailedStructuredAgentSessionForMessage(worktreeId, target.sessionId)
  // Sent as its composer would, so it shows in the chat; reported only once the host answers.
  const { outcome } = sendStructuredAgentSessionMessage({
    sessionId: target.sessionId,
    target: runtime,
    text: prompt,
    callerKeepsText: true
  })
  // Anything else leaves the text with the caller, which keeps its notes.
  return (await outcome) === 'recorded'
    ? { status: 'sent' }
    : { status: 'not-writable', code: 'session-send-refused' }
}
