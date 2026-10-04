// The turn a rig's send opened, as the provider's turn record writes it, for tests where a message
// goes into a running turn: one sent while that send's turn is still opening waits for it.

import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import type { QueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'

/** Opens the turn `id` started; called again with `interrupted` to end it. */
export async function openRigTurnFor(
  rig: QueuedMessageTestRig,
  id: string,
  state: 'running' | 'interrupted' = 'running'
): Promise<void> {
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!journal) {
    throw new Error('expected the conversation open')
  }
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: `turn-of-${id}`, ordinal: 0 },
    {
      kind: 'turn',
      turnId: `turn-of-${id}`,
      startedAt: Date.now(),
      userItemId: agentJournalSubmissionKey(id),
      ...(state === 'running' ? { state } : { state, completedAt: Date.now() })
    },
    {
      fence: rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
}
