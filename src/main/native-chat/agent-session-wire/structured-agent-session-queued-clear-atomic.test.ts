import { afterEach, it, expect, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
let rig: Awaited<ReturnType<typeof createQueuedMessageTestRig>>
afterEach(async () => {
  vi.restoreAllMocks()
  if (rig) {
    await rig.dispose()
  }
})
function clear() {
  const id = hostTestOperationId()
  const fields = { command: 'clear' as const, delivery: 'queue-if-active' as const }
  return {
    id,
    result: rig.host.conversationCommand(CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', id),
      ...fields,
      userSend: true
    })
  }
}
it('commits all carried cards before admitting newer replacement work, even after a copy fault', async () => {
  rig = await createQueuedMessageTestRig()
  const working = await rig.workingSend()
  const clearCard = clear()
  await clearCard.result
  const first = rig.send('older first', 'queue-if-active')
  await first.result
  const second = rig.send('older second', 'queue-if-active')
  await second.result
  const db = openTestJournalHostDatabase(rig.root).db
  db.exec(`CREATE TEMP TRIGGER fail_clear_copy BEFORE INSERT ON queued_messages
    WHEN NEW.session_id != '${SESSION}' AND NEW.message_id = '${second.id}'
    BEGIN SELECT RAISE(ABORT, 'copy interrupted'); END`)
  const removeFault = () => db.exec('DROP TRIGGER IF EXISTS fail_clear_copy')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await rig.settleAccepted(working, 'before-clear')
  await eventually(async () =>
    expect(
      rig.store.getRecord(SESSION)?.conversationCommand?.replacementSessionId ||
        (await rig.drafts()).some(
          (row) => row.messageId === clearCard.id && row.state === 'returned'
        )
    ).toBeTruthy()
  )
  if (!rig.store.getRecord(SESSION)?.conversationCommand?.replacementSessionId) {
    expect((await rig.drafts()).map((row) => row.messageId)).toEqual([
      clearCard.id,
      first.id,
      second.id
    ])
    expect(rig.store.listRecords()).toHaveLength(1)
    removeFault()
    expect(await rig.sendNow(clearCard.id)).toMatchObject({ ok: true })
  }
  const replacement = rig.store.getRecord(SESSION)!.conversationCommand!.replacementSessionId!
  await eventually(async () =>
    expect(
      (await rig.host.journalSnapshot(replacement)).submissions.find(
        (row) => row.queuedMessageId === first.id
      )?.handedOverAt
    ).toBeDefined()
  )
  await eventually(() => expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(false))
  const freshId = hostTestOperationId()
  const fields = {
    body: hostTestMessage('newer replacement message'),
    delivery: 'queue-if-active' as const
  }
  expect(
    await rig.host.send(CALLER, {
      envelope: {
        ...rig.envelope(fields, 'agentSession.send', freshId, replacement),
        expectedRuntimeFence: rig.store.getRecord(replacement)!.lease.runtimeFence
      },
      ...fields,
      userSend: true
    })
  ).toMatchObject({ ok: true, value: { queued: { messageId: freshId } } })
  removeFault()
  rig.crashRestartHostProcess()
  await eventually(async () =>
    expect((await rig.drafts(replacement)).map((row) => row.messageId)).toContain(second.id)
  )
  expect((await rig.drafts(replacement)).map((row) => row.messageId)).toEqual([second.id, freshId])
})
it('never requeues an accepted partial copy after its draft receipt expires', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  const working = await rig.workingSend()
  const clearCard = clear()
  await clearCard.result
  const first = rig.send('already executed followup', 'queue-if-active')
  await first.result
  const second = rig.send('copy that was missing', 'queue-if-active')
  await second.result
  const db = openTestJournalHostDatabase(rig.root).db
  db.exec(`CREATE TEMP TRIGGER fail_clear_copy BEFORE INSERT ON queued_messages
    WHEN NEW.session_id != '${SESSION}' AND NEW.message_id = '${second.id}'
    BEGIN SELECT RAISE(ABORT, 'copy interrupted'); END`)
  const removeFault = () => db.exec('DROP TRIGGER IF EXISTS fail_clear_copy')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await rig.settleAccepted(working, 'before-clear')
  await eventually(async () =>
    expect(
      rig.store.getRecord(SESSION)?.conversationCommand?.replacementSessionId ||
        (await rig.drafts()).some(
          (row) => row.messageId === clearCard.id && row.state === 'returned'
        )
    ).toBeTruthy()
  )
  if (!rig.store.getRecord(SESSION)?.conversationCommand?.replacementSessionId) {
    expect((await rig.drafts()).map((row) => row.messageId)).toEqual([
      clearCard.id,
      first.id,
      second.id
    ])
    expect(rig.store.listRecords()).toHaveLength(1)
    removeFault()
    expect(await rig.sendNow(clearCard.id)).toMatchObject({ ok: true })
  }
  const replacement = rig.store.getRecord(SESSION)!.conversationCommand!.replacementSessionId!
  let firstSubmission = ''
  await eventually(async () => {
    const row = (await rig.host.journalSnapshot(replacement)).submissions.find(
      (row) => row.queuedMessageId === first.id
    )
    expect(row?.handedOverAt).toBeDefined()
    firstSubmission = row!.clientMessageId
  })
  await rig.host.settleLateDispatch({
    sessionId: replacement,
    clientMessageId: firstSubmission,
    providerIdentity: {
      provider: 'codex',
      threadId: THREAD,
      turnId: 'accepted-before-copy-repair',
      ordinal: 0
    }
  })
  await eventually(() => expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(false))
  // Stage the draft receipt as older than the real 24-hour-plus-5-minute retention window.
  openTestJournalHostDatabase(rig.root)
    .db.prepare('UPDATE queued_messages SET settled_at = ? WHERE session_id = ? AND message_id = ?')
    .run(Date.now() - (24 * 60 + 5) * 60 * 1000 - 1000, replacement, first.id)
  // The person closes the replacement after its first turn; the next host can acquire it cleanly.
  await rig.host.close(replacement, 'user-close')
  removeFault()
  rig.crashRestartHostProcess()
  await eventually(async () =>
    expect((await rig.drafts(replacement)).map((row) => row.messageId)).toContain(second.id)
  )
  expect(
    await rig.host.queuedMessagesResume(CALLER, {
      envelope: {
        ...rig.envelope(
          {},
          'agentSession.queuedMessagesResume',
          hostTestOperationId(),
          replacement
        ),
        expectedRuntimeFence: rig.store.getRecord(replacement)!.lease.runtimeFence
      }
    })
  ).toMatchObject({ ok: true, value: { resumed: true } })
  await eventually(() =>
    expect(
      rig.dispatch.mock.calls.filter(([input]) => input.sessionId === replacement)
    ).toHaveLength(2)
  )
  expect(
    (await rig.host.journalSnapshot(replacement)).submissions.filter(
      (row) => row.queuedMessageId === first.id
    )
  ).toHaveLength(1)
})

it.each(['withdrawal', 'record'])('rolls back every clear write when %s fails', async (stage) => {
  rig = await createQueuedMessageTestRig()
  const working = await rig.workingSend()
  const clearCard = clear()
  await clearCard.result
  const followup = rig.send('carry me', 'queue-if-active')
  await followup.result
  const db = openTestJournalHostDatabase(rig.root).db
  const failure =
    stage === 'withdrawal'
      ? `BEFORE UPDATE OF state ON queued_messages WHEN NEW.session_id = '${SESSION}' AND NEW.state = 'withdrawn'`
      : `BEFORE INSERT ON agent_session_records WHEN NEW.session_id != '${SESSION}'`
  db.exec(`CREATE TEMP TRIGGER fail_clear ${failure} BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await rig.settleAccepted(working, 'before-clear')
  await eventually(async () =>
    expect(await rig.drafts()).toEqual([
      { messageId: clearCard.id, state: 'returned' },
      { messageId: followup.id, state: 'waiting' }
    ])
  )
  expect(rig.store.listRecords()).toHaveLength(1)
  expect(rig.store.getRecord(SESSION)?.conversationCommand).toBeUndefined()
  expect(
    db.prepare('SELECT COUNT(*) AS count FROM journal_sessions WHERE session_id != ?').get(SESSION)
  ).toMatchObject({ count: 0 })
  expect(
    db.prepare('SELECT COUNT(*) AS count FROM queued_messages WHERE session_id != ?').get(SESSION)
  ).toMatchObject({ count: 0 })
  db.exec('DROP TRIGGER fail_clear')
  expect(await rig.sendNow(clearCard.id)).toMatchObject({ ok: true })
  expect(rig.store.listRecords()).toHaveLength(2)
})

it('a manually sent clear preserves the reopen pause on cards behind it', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  const working = await rig.workingSend()
  const clearCard = clear()
  await clearCard.result
  const followup = rig.send('wait after restart', 'queue-if-active')
  await followup.result
  await rig.stop()
  await rig.settleAccepted(working, 'before-clear')
  await rig.host.close(SESSION, 'user-close')
  rig.crashRestartHostProcess()
  expect(await rig.sendNow(clearCard.id)).toMatchObject({ ok: true })
  const replacement = rig.store.getRecord(SESSION)?.conversationCommand?.replacementSessionId
  if (!replacement) {
    throw new Error('clear did not commit')
  }
  const journal = rig.host.collaboratorsForTests().sessions.get(replacement)?.journal
  expect(journal?.queuedMessages.pauses().map((pause) => pause.reason)).toContain('restarted')
  expect(await rig.drafts(replacement)).toEqual([{ messageId: followup.id, state: 'waiting' }])
  expect((await rig.host.journalSnapshot(replacement)).submissions).toEqual([])
})
