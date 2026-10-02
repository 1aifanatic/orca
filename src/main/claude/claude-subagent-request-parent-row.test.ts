// A Claude subagent's permission request, replayed from a capture of the real CLI through the real
// adapter, deferred sink, durable journal and status feed, published as production publishes it:
// on the sink's own publish, on a journal commit (a microtask later), and after child work. At every
// status publish the subagents read waiting must each have a pending card in that same journal, and
// the parent row must match a second host fed the same evidence with no subagent ever waiting, as
// the producer was before.

import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalResolution
} from '../../shared/agent-session-journal-types'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import type { AgentStatusStructuredSessionSubject } from '../../shared/agent-status-subject'
import { AgentHookServer } from '../agent-hooks/server'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { settleStructuredAgentSessionDeadGeneration } from '../native-chat/agent-session-wire/structured-agent-session-dead-generation-settlement'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { StructuredAgentSessionStatusFeed } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import { indexedStatusFeedSession } from '../native-chat/agent-session-wire/structured-agent-session-status-feed-test-session'
import { invokeCanUseTool } from './claude-can-use-tool-test-support'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

const SESSION = 'session-1'
const FENCE = 7

type Captured = { from: 'cli' | 'orca'; frame: Record<string, unknown> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function captured(name: string): Captured[] {
  const path = join(__dirname, '__fixtures__', 'claude-subagent-permission-frames.json')
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const events = isRecord(parsed) && isRecord(parsed.scenarios) ? parsed.scenarios[name] : null
  if (!Array.isArray(events)) {
    throw new Error(`no captured scenario ${name}`)
  }
  return events.flatMap((event) =>
    isRecord(event) && (event.from === 'cli' || event.from === 'orca') && isRecord(event.frame)
      ? [{ from: event.from, frame: event.frame }]
      : []
  )
}

/** The subagent that asks in the captures. */
const ASKER = text(
  captured('fg-allow').find((event) => event.frame.subtype === 'task_started')?.frame.task_id
)

/** The same evidence from a producer that never reads a subagent waiting. */
function withoutWaits(evidence: AgentChildWorkEvidence[]): AgentChildWorkEvidence[] {
  return evidence.map((edge) =>
    edge.type === 'live' && edge.child.state === 'waiting'
      ? { ...edge, child: { ...edge.child, state: 'working' } }
      : edge
  )
}

function parentRow(server: AgentHookServer) {
  const row = server.getStatusSnapshot()[0]
  return (
    row && {
      state: row.state,
      workingMode: row.workingMode,
      mainAgent: row.mainAgent,
      stateStartedAt: row.stateStartedAt
    }
  )
}

function pendingCards(items: readonly AgentJournalRenderItem[]): AgentJournalRenderItem[] {
  return items.filter(
    (item) =>
      (item.body.kind === 'approval' || item.body.kind === 'question') &&
      item.body.resolution.state === 'pending'
  )
}

const journals = createTrackedJournalOpener()
let root: string
/** What the host does with the adapter's events, where a test needs it. */
const hooks: { onEvent?: (event: ClaudeStructuredSessionEvent) => void } = {}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-subagent-request-'))
})

afterEach(async () => {
  hooks.onEvent = undefined
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

/** One status publish: what the parent row read beside the main-equivalent host, and whether a
 *  subagent read waiting without a pending card of its own in the journal it was projected from. */
type Publish = { waiting: string[]; askers: string[]; row: unknown; unwaited: unknown }

async function pipeline() {
  let clock = 1_700_000_000_000
  const now = () => (clock += 1)
  const journal: AgentSessionJournal = await journals.open({
    identity: identityFor(SESSION),
    now,
    stateDirectory: join(root, SESSION)
  })
  const server = new AgentHookServer()
  const unwaited = new AgentHookServer()
  const publishes: Publish[] = []
  const record = (subject: AgentStatusStructuredSessionSubject): void => {
    const cards = pendingCards(journal.snapshot().items)
    publishes.push({
      waiting: server
        .getStructuredChildWorkViews(subject)
        .flatMap((view) =>
          view.state === 'waiting' && view.membership === 'live' ? [view.providerId ?? '?'] : []
        ),
      askers: cards.flatMap((card) => (card.agentId ? [card.agentId] : [])),
      row: parentRow(server),
      unwaited: parentRow(unwaited)
    })
  }
  const feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions: new Map([
      [
        SESSION,
        indexedStatusFeedSession({
          journal,
          child: { generation: 'spawn-9', fence: FENCE, phase: 'ready' },
          provider: 'claude'
        })
      ]
    ]),
    getRecord: () => null,
    now,
    statusSink: () => ({
      publish: (summary, subject) => {
        server.ingestStructuredStatus(summary, subject)
        unwaited.ingestStructuredStatus(summary, subject)
        record(subject)
      },
      forget: (subject) => {
        server.dropStructuredStatus(subject)
        unwaited.dropStructuredStatus(subject)
      },
      publishChildWork: (subject, evidence, provider) => {
        server.ingestStructuredChildWork(subject, evidence, provider)
        unwaited.ingestStructuredChildWork(subject, withoutWaits(evidence), provider)
      },
      readChildWork: (subject) => server.getStructuredChildWorkViews(subject)
    })
  })
  // As the host publishes: the sink's own publish, and every journal commit a microtask later.
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging(SESSION))
  deferred.bind({ journal, fence: FENCE, publish: () => feed.publish(SESSION, journal) })
  let queued = false
  journal.observeCommits(() => {
    if (!queued) {
      queued = true
      queueMicrotask(() => {
        queued = false
        feed.publish(SESSION, journal)
      })
    }
  })
  const claude = fakeClaude()
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now,
    persistHandle: async () => {},
    onChildWorkEvidence: (sessionId, evidence) => feed.publishChildWork(sessionId, evidence),
    onEvent: (event) => hooks.onEvent?.(event)
  })
  await adapter.acquire({
    identity: identityFor(SESSION),
    fence: FENCE,
    spawnToken: 'spawn-9',
    events: deferred.sink
  })
  await adapter.awaitStarted(SESSION)
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) {
      expect(await deferred.drained()).toEqual({ ok: true })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  /** What the host's own commit writes for the card: its resolution, at the live turn. */
  const hostRecords =
    (resolution: Pick<AgentJournalResolution, 'state' | 'selectedOptionId'>, itemId = cardId()) =>
    async (): Promise<void> => {
      await deferred.drained()
      const card = pendingCards(journal.snapshot().items).find((item) => item.itemId === itemId)
      const identity = card && parseAgentJournalItemKey(card.itemId)
      if (card?.body.kind !== 'approval' || !identity) {
        throw new Error('no pending card to record')
      }
      await journal.appendItem(
        identity,
        { ...card.body, resolution: { ...resolution, resolvedBy: 'client-1', resolvedAt: now() } },
        { fence: FENCE, turnScope: journal.liveTurnScope() }
      )
    }
  const cardId = (): string => {
    const card = pendingCards(journal.snapshot().items)[0]
    if (!card) {
      throw new Error('no pending card')
    }
    return card.itemId
  }
  const connection = claude.connections[0]!
  const aborts = new Map<string, AbortController>()
  /** Feeds a captured frame as the CLI or the SDK hands it over, then lets every write land. */
  const step = async ({ from, frame }: Captured): Promise<void> => {
    const request = isRecord(frame.request) ? frame.request : null
    if (frame.type === 'control_request' && request?.subtype === 'can_use_tool') {
      const controller = new AbortController()
      aborts.set(text(frame.request_id), controller)
      invokeCanUseTool(
        connection,
        text(request.tool_name),
        text(frame.request_id),
        text(request.tool_use_id),
        {
          input: isRecord(request.input) ? request.input : {},
          signal: controller.signal,
          ...(text(request.agent_id) ? { agentID: text(request.agent_id) } : {})
        }
      )
    } else if (frame.type === 'control_cancel_request') {
      aborts.get(text(frame.request_id))?.abort()
    } else if (from === 'cli') {
      connection.handlers.onMessage?.({ ...frame, session_id: PROVIDER_SESSION_ID })
    }
    await settle()
  }
  /** Replays a capture up to and including its permission request. */
  const ask = async (name: string): Promise<Captured[]> => {
    const events = captured(name)
    const at = events.findIndex((event) => event.frame.type === 'control_request')
    for (const event of events.slice(0, at + 1)) {
      await step(event)
    }
    return events.slice(at + 1)
  }
  /** Publishes that broke the invariant or told the parent rows apart. */
  const violations = () =>
    publishes.filter(
      (entry) =>
        entry.waiting.some((id) => !entry.askers.includes(id)) ||
        !isDeepStrictEqual(entry.row, entry.unwaited)
    )
  /** Raises a request the capture does not hold, as the SDK would. */
  const raise = (requestId: string, toolUseId: string, agentId?: string): void => {
    const controller = new AbortController()
    aborts.set(requestId, controller)
    invokeCanUseTool(connection, 'Bash', requestId, toolUseId, {
      input: { command: `echo ${requestId}` },
      signal: controller.signal,
      ...(agentId ? { agentID: agentId } : {})
    })
  }
  return {
    adapter,
    journal,
    deferred,
    connection,
    now,
    raise,
    publishes,
    violations,
    settle,
    step,
    ask,
    cardId,
    hostRecords,
    aborts
  }
}

type Pipeline = Awaited<ReturnType<typeof pipeline>>

function answer(
  run: Pipeline,
  optionId: 'allow' | 'deny',
  commit = run.hostRecords({ state: 'resolved', selectedOptionId: optionId }),
  itemId = run.cardId()
) {
  return run.adapter.answerPrompt({
    sessionId: SESSION,
    itemId,
    kind: 'approval',
    response: { kind: 'option', optionId },
    fence: FENCE,
    commit
  })
}

function dismiss(run: Pipeline, decline: boolean) {
  return run.adapter.dismissPrompt({
    sessionId: SESSION,
    itemId: run.cardId(),
    fence: FENCE,
    answer: decline,
    commit: run.hostRecords({ state: 'cancelled', selectedOptionId: null })
  })
}

/** Replays a whole capture, answering through the app's own path where Orca answered. */
async function replay(name: string): Promise<Pipeline> {
  const run = await pipeline()
  for (const event of captured(name)) {
    const response = isRecord(event.frame.response) ? event.frame.response : null
    if (event.from === 'orca' && event.frame.type === 'control_response' && response) {
      const behavior = isRecord(response.response) ? text(response.response.behavior) : ''
      await answer(run, behavior === 'deny' ? 'deny' : 'allow')
      await run.settle()
    } else {
      await run.step(event)
    }
  }
  return run
}

describe("the parent row while a Claude subagent's request is open", () => {
  it.each(['fg-allow', 'fg-deny', 'fg-interrupt', 'bg-allow'])(
    'never reads a subagent waiting beside no card, and reads as before, through %s',
    async (name) => {
      const run = await replay(name)
      expect(run.publishes.some((entry) => entry.waiting.length > 0)).toBe(true)
      expect(run.violations()).toEqual([])
    }
  )

  it('reads blocked as soon as the request arrives, dated by its card', async () => {
    const run = await pipeline()
    await run.ask('fg-allow')
    const card = pendingCards(run.journal.snapshot().items)[0]
    expect(run.publishes.at(-1)).toMatchObject({
      waiting: [card?.agentId],
      row: {
        state: 'blocked',
        stateStartedAt: card?.observedAt,
        mainAgent: { state: 'blocked', stateStartedAt: card?.observedAt }
      }
    })
    expect(
      run.publishes.filter((entry) => isRecord(entry.row) && entry.row.state === 'waiting')
    ).toEqual([])
    expect(run.violations()).toEqual([])
  })

  it.each([
    ['declines the request', true],
    ['leaves the request to the Stop that ends it', false]
  ])('frees the subagent when the user dismisses the card and Orca %s', async (_, decline) => {
    const run = await pipeline()
    await run.ask('fg-allow')
    await dismiss(run, decline)
    await run.settle()
    // Claude's own withdrawal, after a Stop, closes nothing more.
    for (const controller of run.aborts.values()) {
      controller.abort()
    }
    await run.settle()
    expect(run.publishes.at(-1)?.waiting).toEqual([])
    expect(run.violations()).toEqual([])
  })

  it('waits again, beside its card, when the host fails to record the answer', async () => {
    const run = await pipeline()
    await run.ask('fg-allow')
    await expect(
      answer(run, 'allow', async () => {
        throw new Error('journal write failed')
      })
    ).rejects.toThrow('journal write failed')
    await run.settle()
    expect(run.publishes.at(-1)?.waiting).toHaveLength(1)
    expect(run.violations()).toEqual([])
  })

  it('keeps an answered request in the rows of the subagent that asked', async () => {
    const run = await replay('fg-allow')
    const card = run.journal.snapshot().items.find((item) => item.body.kind === 'approval')
    expect(card?.agentId).toBe(ASKER)
    expect(card?.body).toMatchObject({
      resolution: { state: 'resolved', selectedOptionId: 'allow' }
    })
  })

  it('waits each asking subagent beside its own card, and only those, as requests open and close', async () => {
    const run = await pipeline()
    await run.ask('fg-allow')
    const started = captured('fg-allow').find((event) => event.frame.subtype === 'task_started')
    await run.step({
      from: 'cli',
      frame: { ...started?.frame, task_id: 'agent-two', uuid: 'u-two', tool_use_id: 'toolu_two' }
    })
    run.raise('req-two', 'toolu_two_bash', 'agent-two')
    await run.settle()
    expect([...(run.publishes.at(-1)?.waiting ?? [])].sort()).toEqual([ASKER, 'agent-two'].sort())
    const cardOf = (agentId: string) =>
      pendingCards(run.journal.snapshot().items).find((card) => card.agentId === agentId)?.itemId
    const first = cardOf(ASKER)
    await answer(
      run,
      'allow',
      run.hostRecords({ state: 'resolved', selectedOptionId: 'allow' }, first),
      first
    )
    await run.settle()
    expect(run.publishes.at(-1)?.waiting).toEqual(['agent-two'])
    const second = cardOf('agent-two')
    await answer(
      run,
      'allow',
      run.hostRecords({ state: 'resolved', selectedOptionId: 'allow' }, second),
      second
    )
    await run.settle()
    expect(run.publishes.at(-1)?.waiting).toEqual([])
    expect(run.violations()).toEqual([])
  })

  it("stays blocked on the session's own request after its subagent's is answered", async () => {
    const run = await pipeline()
    await run.ask('fg-allow')
    run.raise('req-main', 'toolu_main_bash')
    await run.settle()
    const cards = pendingCards(run.journal.snapshot().items)
    expect(cards.map((card) => card.agentId ?? null).sort()).toEqual([ASKER, null].sort())
    expect(run.publishes.at(-1)?.waiting).toEqual([ASKER])
    const subagents = cards.find((card) => card.agentId === ASKER)?.itemId
    await answer(
      run,
      'allow',
      run.hostRecords({ state: 'resolved', selectedOptionId: 'allow' }, subagents),
      subagents
    )
    await run.settle()
    expect(run.publishes.at(-1)).toMatchObject({ waiting: [], row: { state: 'blocked' } })
    expect(run.violations()).toEqual([])
  })

  it.each(['at once', 'after the provider writes flush'] as const)(
    'stops the subagent waiting when the process dies mid-request and the host settles it %s',
    async (when) => {
      const run = await pipeline()
      await run.ask('fg-allow')
      expect(run.publishes.at(-1)?.waiting).toEqual([ASKER])
      let settled: Promise<unknown> | undefined
      hooks.onEvent = (event) => {
        if (event.type !== 'ended') {
          return
        }
        const settle = () =>
          settleStructuredAgentSessionDeadGeneration({
            journal: run.journal,
            sessionId: SESSION,
            fence: FENCE,
            settlementId: 'provider-exit:test',
            verdict: { state: 'interrupted', completedAt: run.now() },
            pendingSubmissionReason: 'provider_exited_before_acknowledgement'
          })
        settled = when === 'at once' ? settle() : run.deferred.drained().then(settle)
      }
      run.connection.handlers.onExit?.(new Error('claude crashed'))
      for (let attempt = 0; attempt < 20 && !settled; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await settled
      await run.settle()
      expect(pendingCards(run.journal.snapshot().items)).toEqual([])
      expect(run.publishes.at(-1)?.waiting).toEqual([])
      expect(run.violations()).toEqual([])
    }
  )
})
