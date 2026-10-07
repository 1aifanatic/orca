import { useMemo, useState } from 'react'
import {
  agentSessionSignInCopyId,
  type AgentSessionUnavailable
} from '../../../../shared/agent-session-availability'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentType } from '../../../../shared/agent-status-types'
import { agentSessionRefusalReasonWords } from '../../../../shared/agent-session-refusal-reason-words'
import type { AgentSessionWriteRefusal } from '../../../../shared/agent-session-write-failure'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import { structuredAgentSessionStartFailureFacts } from './structured-agent-session-delivery-notices'

/** The host's verdict on why no chat can start here, as a notice that never holds Send: the
 *  verdict can be wrong while a send would work. Dismissed per verdict, so a changed or returning
 *  one shows again; left out while the chat's latest start failure already says the same reason. */
export function useNativeChatAvailabilityNotice(input: {
  unavailable: AgentSessionUnavailable | null | undefined
  agent: AgentType
  agentLabel: string
  launchFailure: AgentSessionWriteRefusal | null
  journalItems: readonly AgentJournalRenderItem[] | undefined
}): NativeChatComposerNotice | null {
  const { unavailable, journalItems } = input
  const key = !unavailable
    ? null
    : unavailable.reason === 'notSignedIn'
      ? `notSignedIn:${unavailable.account ?? ''}`
      : unavailable.reason
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (key === null && dismissed !== null) {
    // A cleared verdict ends its dismissal, so the same one coming back shows again.
    setDismissed(null)
  }
  const lastRowReason = useMemo(
    () =>
      journalItems ? structuredAgentSessionStartFailureFacts(journalItems).at(-1)?.kind : null,
    [journalItems]
  )
  if (!unavailable || key === dismissed) {
    return null
  }
  const launchWords = input.launchFailure && agentSessionRefusalReasonWords(input.launchFailure)
  const launchReason = launchWords && 'fact' in launchWords ? launchWords.fact : null
  if (launchReason === unavailable.reason || lastRowReason === unavailable.reason) {
    return null
  }
  const provider = input.agent === 'codex' ? 'codex' : 'claude'
  return {
    key: 'availability',
    kind: 'error',
    text:
      unavailable.reason === 'cliMissing'
        ? sayAgentSessionFailureTranslated('cliMissing', { agent: input.agentLabel })
        : sayAgentSessionFailureTranslated(agentSessionSignInCopyId(provider, unavailable.account)),
    onDismiss: () => setDismissed(key)
  }
}
