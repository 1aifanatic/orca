import { useMemo } from 'react'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type { MobileStructuredSendReachedHost } from './mobile-native-chat-draft-reconcile'
import {
  mobileStructuredSendInJournal,
  mobileStructuredSendsInJournal
} from './mobile-structured-send-operation-journal'

/** Whether the loaded journal holds the structured send made under an id, in any state; the same
 *  record the phone's id reconciliation reads. Rebuilt only when the submissions change. */
export function useMobileStructuredSendReachedHost(
  submissions: readonly AgentJournalSubmission[]
): MobileStructuredSendReachedHost {
  return useMemo(() => {
    const sends = mobileStructuredSendsInJournal(submissions, false)
    return (clientMessageId) => mobileStructuredSendInJournal(sends, clientMessageId)
  }, [submissions])
}
