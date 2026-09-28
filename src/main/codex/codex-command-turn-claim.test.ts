import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionRevisionJournal,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

const SESSION = 'session-1'
const THREAD = 'thread-1'
const PROVIDER_TURN = 'compact-turn'
const COMMAND_TURN_IDENTITY: AgentJournalItemIdentity = {
  provider: 'orca',
  clientMessageId: 'command-turn:cmd-1'
}
const COMMAND_TURN_KEY = agentJournalItemKey(COMMAND_TURN_IDENTITY)
const RUNNING = {
  kind: 'turn' as const,
  turnId: 'compact:cmd-1',
  state: 'running' as const,
  userItemId: 'orca:submission:cmd-1',
  requestedAt: 1,
  startedAt: 1
}
const COMMAND = {
  clientMessageId: 'cmd-1',
  turnId: RUNNING.turnId,
  identity: COMMAND_TURN_IDENTITY,
  resultIdentity: { provider: 'orca' as const, clientMessageId: 'command-result:cmd-1' },
  running: RUNNING
}
const ACCEPTED: StructuredAgentSessionSinkAdmission = { accepted: true }

type Written = { key: string; body: AgentJournalItemBody; turnScope?: AgentJournalTurnScope }

/** Records every write with the scope it states; the journal holds the running command turn. */
function recorder(refuseRevisions = 0) {
  const writes: Written[] = []
  const record = (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    turnScope?: AgentJournalTurnScope
  ) => writes.push({ key: agentJournalItemKey(identity), body, turnScope })
  const commandTurn: AgentJournalItemBody = RUNNING
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the claim resolver reads only `itemBody`.
  const journal = {
    itemBody: (itemId: string) => (itemId === COMMAND_TURN_KEY ? commandTurn : null)
  } as unknown as StructuredAgentSessionRevisionJournal
  let refusals = refuseRevisions
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options) => record(identity, body, options.turnScope),
    appendTombstone: () => {},
    publish: () => {},
    tryPublish: () => ACCEPTED,
    tryAppendItem: (identity, body, options) => {
      record(identity, body, options.turnScope)
      return ACCEPTED
    },
    appendLifecycleBatch: (_settlementId, mutations) => {
      for (const mutation of mutations) {
        if (mutation.kind === 'item') {
          record(mutation.identity, mutation.body, mutation.turnScope)
        }
      }
    },
    tryReviseResolvedItemAndPublish: (_bytes, resolve, options) => {
      if (refusals > 0) {
        refusals -= 1
        return { accepted: false, reason: 'backpressure' }
      }
      const resolved = resolve(journal)
      if (resolved) {
        record(resolved.identity, resolved.body, options.turnScope)
      }
      return ACCEPTED
    }
  }
  return { sink, writes }
}

/** Codex names the thread inside every notification's params too. */
function notification(
  method: string,
  params: Record<string, unknown>
): CodexStructuredSessionEvent {
  return {
    type: 'notification',
    sessionId: SESSION,
    threadId: THREAD,
    method,
    params: { threadId: THREAD, ...params }
  }
}

function harness(refuseRevisions = 0) {
  const tap = recorder(refuseRevisions)
  const translator = createCodexJournalTranslator({
    sink: tap.sink,
    sessionId: SESSION,
    primaryThreadId: () => THREAD
  })
  return {
    ...tap,
    translator,
    emit: (event: CodexStructuredSessionEvent) => translator.handle(event)
  }
}

const codexTurnRecords = (writes: readonly Written[]) =>
  writes.filter((write) => write.key !== COMMAND_TURN_KEY && readAgentJournalTurn(write.body))

/** The command turn's newest body, as the journal would hold it. */
const commandTurn = (writes: readonly Written[]) =>
  readAgentJournalTurn(writes.findLast((write) => write.key === COMMAND_TURN_KEY)?.body)

const resultRows = (writes: readonly Written[]) =>
  writes.filter((write) => write.body.kind === 'status')

describe('a Codex turn a conversation command claims', () => {
  it('is the command turn: writes no root turn, scopes its content there, and ends it', () => {
    const { writes, translator, emit } = harness()
    translator.beginCommand(COMMAND)

    emit(notification('turn/started', { turn: { id: PROVIDER_TURN } }))
    // The claim is persisted on the command turn: nothing else re-derives it later.
    expect(commandTurn(writes)).toMatchObject({ state: 'running', providerTurnId: PROVIDER_TURN })
    emit(
      notification('item/completed', {
        turnId: PROVIDER_TURN,
        item: { type: 'agentMessage', id: 'summary', text: 'Summary of the conversation.' }
      })
    )
    emit(
      notification('item/completed', {
        turnId: PROVIDER_TURN,
        item: { type: 'contextCompaction', id: 'compaction' }
      })
    )
    emit(notification('turn/completed', { turn: { id: PROVIDER_TURN, status: 'completed' } }))

    expect(codexTurnRecords(writes)).toEqual([])
    const scope = { kind: 'turn', turnItemId: COMMAND_TURN_KEY }
    const summary = writes.find(
      (write) => write.body.kind === 'message' && write.body.role === 'assistant'
    )
    expect(summary?.turnScope).toEqual(scope)
    // Codex's own marker is the command's result row.
    expect(resultRows(writes)).toEqual([
      expect.objectContaining({
        body: { kind: 'status', text: 'Context compacted', presentation: 'compaction' },
        turnScope: scope
      })
    ])
    expect(commandTurn(writes)).toMatchObject({
      state: 'completed',
      outcome: 'success',
      providerTurnId: PROVIDER_TURN,
      userItemId: RUNNING.userItemId,
      requestedAt: RUNNING.requestedAt
    })
  })

  it('reads an interrupted turn as the command cancelled, with no result row', () => {
    const { writes, translator, emit } = harness()
    translator.beginCommand(COMMAND)
    emit(notification('turn/started', { turn: { id: PROVIDER_TURN } }))
    emit(notification('turn/completed', { turn: { id: PROVIDER_TURN, status: 'interrupted' } }))

    expect(commandTurn(writes)).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(resultRows(writes)).toEqual([])
  })

  it('reads a turn that completed without compacting as a failure, with the reason', () => {
    const { writes, translator, emit } = harness()
    translator.beginCommand(COMMAND)
    emit(notification('turn/started', { turn: { id: PROVIDER_TURN } }))
    emit(
      notification('turn/completed', {
        turn: { id: PROVIDER_TURN, status: 'failed', error: { message: 'Unavailable' } }
      })
    )

    expect(commandTurn(writes)).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(resultRows(writes).map((write) => write.body)).toEqual([
      { kind: 'status', text: 'Unavailable', tone: 'error' }
    ])
  })

  it('names no provider turn for a Stop until Codex opens one, then the one it opened', () => {
    const { translator, emit } = harness()
    translator.beginCommand(COMMAND)
    expect(translator.commandProviderTurnId(COMMAND.turnId)).toBeUndefined()
    emit(notification('turn/started', { turn: { id: PROVIDER_TURN } }))
    expect(translator.commandProviderTurnId(COMMAND.turnId)).toBe(PROVIDER_TURN)
    expect(translator.commandProviderTurnId('ordinary')).toBe('ordinary')
  })

  it('claims the same provider turn when the refused start is retried', () => {
    const { writes, translator, emit } = harness(1)
    translator.beginCommand(COMMAND)
    const started = notification('turn/started', { turn: { id: PROVIDER_TURN } })

    expect(emit(started)).toEqual({ accepted: false, reason: 'backpressure' })
    expect(emit(started)).toEqual(ACCEPTED)

    expect(codexTurnRecords(writes)).toEqual([])
    expect(commandTurn(writes)).toMatchObject({ providerTurnId: PROVIDER_TURN })
    expect(translator.commandProviderTurnId(COMMAND.turnId)).toBe(PROVIDER_TURN)
  })

  it('leaves a primary turn no command claims to write its own record', () => {
    const { writes, translator, emit } = harness()
    translator.beginCommand(COMMAND)
    translator.forgetCommand(COMMAND.turnId)
    emit(notification('turn/started', { turn: { id: 'ordinary' } }))
    emit(notification('turn/completed', { turn: { id: 'ordinary', status: 'completed' } }))
    expect(
      codexTurnRecords(writes).map((write) => readAgentJournalTurn(write.body)?.state)
    ).toEqual(['running', 'completed'])
  })
})
