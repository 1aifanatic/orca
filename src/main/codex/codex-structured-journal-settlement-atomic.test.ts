import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import {
  createTrackedJournalOpener,
  liveTestJournalRows,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { appendCodexLifecycleMutations } from './codex-structured-journal-sink'
import type { JournalLifecycleIdentityMutationInput } from '../native-chat/agent-session-journal/journal-row-builders'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

const SESSION = 'codex-atomic'
const journals = createTrackedJournalOpener()
let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('rolls back the entire Codex exit settlement when a later row fails, then commits once on retry', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-atomic-'))
  const options = {
    identity: {
      sessionId: SESSION,
      workspaceId: 'folder',
      hostId: 'host',
      agent: 'codex' as const,
      providerHandle: codexProviderHandle('thread')
    },
    stateDirectory: root,
    now: () => 1_000
  }
  const journal = await journals.open(options)
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging(SESSION))
  const published: ReturnType<typeof journal.snapshot>[] = []
  const publish = vi.fn(() => {
    published.push(journal.snapshot())
  })
  const commits = vi.fn()
  deferred.bind({ journal, fence: 7, publish })
  const batches: {
    settlementId: string
    mutations: readonly JournalLifecycleIdentityMutationInput[]
  }[] = []
  const appendBatch = deferred.sink.tryAppendLifecycleBatch
  if (!appendBatch) {
    throw new Error('test sink lacks lifecycle append')
  }
  deferred.sink.tryAppendLifecycleBatch = (settlementId, mutations, options) => {
    batches.push({ settlementId, mutations })
    return appendBatch(settlementId, mutations, options)
  }
  const translator = createCodexJournalTranslator({
    sink: deferred.sink,
    primaryThreadId: () => 'thread',
    now: () => 900
  })
  const notification = (method: string, params: unknown): CodexStructuredSessionEvent => ({
    type: 'notification',
    sessionId: SESSION,
    threadId: 'thread',
    method,
    params
  })
  expect(translator.handle(notification('turn/started', { turn: { id: 'turn' } }))).toEqual({
    accepted: true
  })
  for (let index = 0; index < 201; index++) {
    expect(
      translator.handle(
        notification('item/started', {
          item: {
            type: 'commandExecution',
            id: `call-${index}`,
            command: 'run',
            status: 'inProgress'
          }
        })
      )
    ).toEqual({ accepted: true })
  }
  await expect(deferred.drained()).resolves.toEqual({ ok: true })
  published.length = 0
  journal.observeCommits(commits)
  const before = journal.snapshot()
  const database = openTestJournalHostDatabase(root)
  const diskBefore = liveTestJournalRows(database.db, SESSION)
  const sawEarlierInserts: number[] = []
  const transaction = database.transaction.bind(database)
  vi.spyOn(database, 'transaction').mockImplementation((run) =>
    transaction((db) => {
      try {
        return run(db)
      } catch (error) {
        sawEarlierInserts.push(liveTestJournalRows(db, SESSION).length - diskBefore.length)
        expect(journal.snapshot()).toEqual(before)
        expect(commits).not.toHaveBeenCalled()
        expect(
          published.every((snapshot) => JSON.stringify(snapshot) === JSON.stringify(before))
        ).toBe(true)
        throw error
      }
    })
  )
  database.db.exec(`CREATE TEMP TRIGGER reject_codex_later BEFORE INSERT ON journal_rows
    WHEN NEW.session_id = '${SESSION}' AND NEW.seq > ${before.cursor.sequence + 1}
    BEGIN SELECT RAISE(ABORT, 'later Codex settlement row rejected'); END`)
  const ended = {
    type: 'ended' as const,
    sessionId: SESSION,
    reason: 'lost child',
    cause: 'unexpected-exit' as const,
    observedAt: 1_000,
    fence: 7,
    acquisitionGeneration: 'generation'
  }
  expect(translator.handle(ended)).toEqual({ accepted: true })
  await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
  expect(sawEarlierInserts).toEqual([1])
  expect(liveTestJournalRows(database.db, SESSION)).toEqual(diskBefore)
  expect(journal.snapshot()).toEqual(before)
  expect(commits).not.toHaveBeenCalled()
  expect(published.every((snapshot) => JSON.stringify(snapshot) === JSON.stringify(before))).toBe(
    true
  )
  vi.restoreAllMocks()
  database.db.exec('DROP TRIGGER reject_codex_later')
  const retry = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging(SESSION))
  retry.bind({ journal, fence: 7, publish })
  const [batch] = batches
  expect(batches).toHaveLength(1)
  if (!batch) {
    throw new Error('test settlement was not submitted')
  }
  expect(appendCodexLifecycleMutations(retry.sink, batch.settlementId, batch.mutations)).toEqual({
    accepted: true
  })
  await expect(retry.drained()).resolves.toEqual({ ok: true })
  expect(commits).toHaveBeenCalledTimes(1)
  const settled = journal.snapshot()
  expect(published.at(-1)).toEqual(settled)
  expect(settled.items.filter((item) => item.body.kind === 'tool-call')).toHaveLength(201)
  expect(
    settled.items
      .filter((item) => item.body.kind === 'tool-call')
      .every((item) => item.body.kind === 'tool-call' && item.body.state === 'failed')
  ).toBe(true)
  expect(settled.items.find((item) => item.body.kind === 'turn')?.body).toMatchObject({
    state: 'interrupted'
  })
  expect(liveTestJournalRows(database.db, SESSION)).toHaveLength(diskBefore.length + 2)
  expect(appendCodexLifecycleMutations(retry.sink, batch.settlementId, batch.mutations)).toEqual({
    accepted: true
  })
  await expect(retry.drained()).resolves.toEqual({ ok: true })
  expect(commits).toHaveBeenCalledTimes(1)
  expect(journal.snapshot()).toEqual(settled)
  await journal.close()
  expect((await journals.open(options)).snapshot()).toEqual(settled)
  translator.dispose()
  deferred.close()
  retry.close()
})
