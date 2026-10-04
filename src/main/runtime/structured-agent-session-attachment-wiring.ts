// Installs the chat attachment store beside the structured host, and its sweeps. The store lives in
// the same state directory as the journal, and the sweeps read the host's records and journal.

import { join } from 'node:path'
import { AGENT_SESSION_ATTACHMENTS_DIR_NAME } from '../../shared/agent-session-attachments'
import {
  AgentSessionAttachmentStore,
  setAgentSessionAttachmentStore
} from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import {
  startAgentSessionAttachmentSweeps,
  type AgentSessionAttachmentSweeper
} from '../native-chat/agent-session-attachments/agent-session-attachment-sweep'
import { createAgentSessionAttachmentJournalMentions } from '../native-chat/agent-session-attachments/agent-session-attachment-journal-references'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { AgentSessionRecordStore } from './agent-session-record-store'

const FIRST_SWEEP_DELAY_MS = 60 * 1000
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

let sweeper: AgentSessionAttachmentSweeper | null = null

export function installAgentSessionAttachments(deps: {
  stateDirectory: string
  store: AgentSessionRecordStore
  journalDatabase: JournalHostDatabase
  logger: StructuredAgentSessionLogger
}): void {
  stopAgentSessionAttachments()
  const attachments = new AgentSessionAttachmentStore(
    join(deps.stateDirectory, AGENT_SESSION_ATTACHMENTS_DIR_NAME)
  )
  setAgentSessionAttachmentStore(attachments)
  sweeper = startAgentSessionAttachmentSweeps(
    attachments,
    {
      // Records still owed their import are missing from the list, so nothing reads as abandoned.
      recordedSessionIds: () =>
        deps.journalDatabase.legacyRecordImportOwed ? null : deps.store.listRecordedSessionIds(),
      journalMentions: createAgentSessionAttachmentJournalMentions(() => deps.journalDatabase.db)
    },
    {
      initialDelayMs: FIRST_SWEEP_DELAY_MS,
      intervalMs: SWEEP_INTERVAL_MS,
      onError: (error) =>
        deps.logger.warn('chat attachment sweep failed', { scope: 'attachment-sweep', error })
    }
  )
}

export function stopAgentSessionAttachments(): void {
  sweeper?.stop()
  sweeper = null
  setAgentSessionAttachmentStore(null)
}
