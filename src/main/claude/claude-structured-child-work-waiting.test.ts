// A Claude subagent blocked on a permission request, replayed from a capture of the real CLI
// through the real adapter into the host's child records. Every status publish also lands on a
// second host fed the same evidence with no subagent ever waiting, as the producer was before: the
// parent row must not tell the two apart.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalProducerLinkage,
  type AgentJournalRenderItem,
  type AgentJournalResolution
} from '../../shared/agent-session-journal-types'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { projectStructuredAgentSessionStatusSummary } from '../../shared/structured-agent-session-projection'
import type { AgentHookServer } from '../agent-hooks/server'
import {
  hostWithParent,
  parent,
  producer,
  system,
  toolUse
} from './claude-child-work-producer-harness.test-fixture'
import { invokeCanUseTool } from './claude-can-use-tool-test-support'
import { PROVIDER_SESSION_ID, type FakeConnection } from './claude-structured-session-test-support'

type CapturedEvent = { from: 'cli' | 'orca'; frame: Record<string, unknown> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function capturedScenario(name: string): CapturedEvent[] {
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

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Hands `canUseTool` exactly what the SDK hands it for this wire request. */
function requestFromWire(
  connection: FakeConnection,
  wire: Record<string, unknown>,
  options: { signal?: AbortSignal; withoutAgentId?: boolean } = {}
): void {
  const request = isRecord(wire.request) ? wire.request : {}
  const agentId = options.withoutAgentId ? '' : text(request.agent_id)
  invokeCanUseTool(
    connection,
    text(request.tool_name),
    text(wire.request_id),
    text(request.tool_use_id),
    {
      input: isRecord(request.input) ? request.input : {},
      ...(options.signal ? { signal: options.signal } : {}),
      ...(agentId ? { agentID: agentId } : {})
    }
  )
}

type ParentRow = Pick<
  AgentStatusIpcPayload,
  'state' | 'workingMode' | 'mainAgent' | 'stateStartedAt'
>

function parentRowOf(host: AgentHookServer): ParentRow | undefined {
  const row = host.getStatusSnapshot()[0]
  return (
    row && {
      state: row.state,
      workingMode: row.workingMode,
      mainAgent: row.mainAgent,
      stateStartedAt: row.stateStartedAt
    }
  )
}

/** The same evidence from a producer that never reads a subagent waiting. */
function withoutWaits(evidence: AgentChildWorkEvidence[]): AgentChildWorkEvidence[] {
  return evidence.map((edge) =>
    edge.type === 'live' && edge.child.state === 'waiting'
      ? { ...edge, child: { ...edge.child, state: 'working' } }
      : edge
  )
}

/** A session past startup, so no startup frame drains child work for the step under test. Its
 *  status is published as the feed publishes it: after every child-work delivery, and wherever a
 *  journal publication would land. */
async function startedProducer() {
  const host = hostWithParent()
  const unwaitedHost = hostWithParent()
  const publishes: { row?: ParentRow; unwaited?: ParentRow; childWaiting: boolean }[] = []
  const journal: { items: () => AgentJournalRenderItem[]; now: () => number } = {
    items: () => [],
    now: () => 0
  }
  const publish = (): void => {
    const summary = projectStructuredAgentSessionStatusSummary(journal.items())
    if (summary.status === null) {
      return
    }
    for (const target of [host, unwaitedHost]) {
      target.ingestStructuredStatus(
        {
          ...summary,
          status: summary.status,
          sessionId: parent.sessionId,
          workspaceId: parent.workspaceId,
          agent: 'claude',
          hostExecutionOwned: true,
          updatedAt: journal.now()
        },
        parent
      )
    }
    publishes.push({
      row: parentRowOf(host),
      unwaited: parentRowOf(unwaitedHost),
      childWaiting: host.getStructuredChildWork(parent).some((child) => child.state === 'waiting')
    })
  }
  const harness = await producer(host, (evidence) => {
    unwaitedHost.ingestStructuredChildWork(parent, withoutWaits(evidence), 'claude')
    publish()
  })
  journal.items = harness.journalItems
  journal.now = harness.now
  await harness.adapter.awaitStarted('session-1')
  await new Promise((resolve) => setTimeout(resolve, 0))
  /** Publishes where the two hosts' parent rows differed. */
  const divergences = () =>
    publishes.filter((entry) => !isDeepStrictEqual(entry.row, entry.unwaited))
  return { ...harness, host, publish, publishes, divergences }
}

type Harness = Awaited<ReturnType<typeof startedProducer>>

/** What `commit` writes: the host's own record of the card, then the status publish its journal
 *  commit delivers before the adapter resumes. */
function hostRecordsCard(
  harness: Harness,
  resolution: Pick<AgentJournalResolution, 'state' | 'selectedOptionId'>
): void {
  const card = harness
    .journalItems()
    .find((item) => item.body.kind === 'approval' && item.body.resolution.state === 'pending')
  const identity = card && parseAgentJournalItemKey(card.itemId)
  if (card?.body.kind !== 'approval' || !identity) {
    throw new Error('no pending card to record')
  }
  harness.journal.appendItem(
    identity,
    { ...card.body, resolution: { ...resolution, resolvedBy: 'client-1', resolvedAt: 1 } },
    { turnScope: card.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE }
  )
  harness.publish()
}

/** Replays a capture up to its permission request and raises it, as the SDK would. */
async function askedAt(name: string, options: { withoutAgentId?: boolean } = {}) {
  const harness = await startedProducer()
  const events = capturedScenario(name)
  const request = events.findIndex((event) => event.frame.type === 'control_request')
  for (const { frame } of events.slice(0, request)) {
    harness.send({ ...frame, session_id: PROVIDER_SESSION_ID })
  }
  requestFromWire(harness.claude.connections[0]!, events[request]!.frame, options)
  harness.publish()
  return harness
}

/** Binds the capture's request to a card id, as the journal binds its row. */
function boundCard(harness: Harness, name: string): string {
  const request = capturedScenario(name).find((event) => event.frame.type === 'control_request')
  const requestId = text(request?.frame.request_id)
  harness.adapter.bindPromptItemId('session-1', `item-${requestId}`, requestId)
  return `item-${requestId}`
}

function subagentTaskId(name: string): string {
  const started = capturedScenario(name).find((event) => event.frame.subtype === 'task_started')
  return text(started?.frame.task_id)
}

/** Replays one capture and returns the subagent's record state after each event, labelled. */
async function replay(name: string, options: { withoutAgentId?: boolean } = {}) {
  const harness = await startedProducer()
  const { adapter, claude, send } = harness
  const connection = claude.connections[0]!
  const aborts = new Map<string, AbortController>()
  const timeline: string[] = []
  const subagent = () => harness.records().find((record) => record.kind === 'agent')
  for (const { from, frame } of capturedScenario(name)) {
    const request = isRecord(frame.request) ? frame.request : null
    const response = isRecord(frame.response) ? frame.response : null
    let label = text(frame.subtype) || text(frame.type)
    if (frame.type === 'control_request' && request?.subtype === 'can_use_tool') {
      const controller = new AbortController()
      aborts.set(text(frame.request_id), controller)
      requestFromWire(connection, frame, { ...options, signal: controller.signal })
      label = 'can_use_tool'
    } else if (frame.type === 'control_cancel_request') {
      aborts.get(text(frame.request_id))?.abort()
    } else if (from === 'orca' && frame.type === 'control_response' && response) {
      // Answered through the app's own path, as the pane's approval card answers it.
      const requestId = text(response.request_id)
      const behavior = isRecord(response.response) ? text(response.response.behavior) : ''
      adapter.bindPromptItemId('session-1', `item-${requestId}`, requestId)
      const optionId = behavior === 'deny' ? 'deny' : 'allow'
      await adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: `item-${requestId}`,
        kind: 'approval',
        response: { kind: 'option', optionId },
        fence: 7,
        commit: async () =>
          hostRecordsCard(harness, { state: 'resolved', selectedOptionId: optionId })
      })
      label = behavior
    } else if (from === 'orca') {
      // The interrupt itself changes nothing here; the CLI's cancel frame that follows does.
      label = text(request?.subtype)
    } else {
      send({ ...frame, session_id: PROVIDER_SESSION_ID })
    }
    harness.publish()
    const record = subagent()
    timeline.push(`${label} -> ${record ? `${record.membership} ${record.state}` : 'none'}`)
  }
  return { ...harness, timeline, subagent }
}

/** The events around the permission request, where the subagent's state is decided. */
function aroundRequest(timeline: string[]): string[] {
  const at = timeline.findIndex((entry) => entry.startsWith('can_use_tool'))
  return timeline.slice(at - 1, at + 3)
}

describe('a Claude subagent waiting on a permission request', () => {
  it('reads waiting from the request until it is allowed, then working', async () => {
    const { timeline } = await replay('fg-allow')
    expect(aroundRequest(timeline)).toEqual([
      'session_state_changed -> live working',
      'can_use_tool -> live waiting',
      'allow -> live working',
      'session_state_changed -> live working'
    ])
    expect(timeline.at(-1)).toBe('success -> settled done')
  })

  it('keeps the tool it is blocked on while it waits', async () => {
    const harness = await startedProducer()
    const events = capturedScenario('fg-allow')
    const request = events.findIndex((event) => event.frame.type === 'control_request')
    for (const { frame } of events.slice(0, request)) {
      harness.send({ ...frame, session_id: PROVIDER_SESSION_ID })
    }
    requestFromWire(harness.claude.connections[0]!, events[request]!.frame)
    expect(harness.byDescription('Touch probe file')).toMatchObject({
      state: 'waiting',
      operation: { toolName: 'Bash', input: 'touch c9-probe-fg.txt', basis: 'open' }
    })
  })

  it('reads the parent row as before while its subagent asks: blocked, dated by the request', async () => {
    const harness = await askedAt('fg-allow')
    const approval = harness.journalItems().find((item) => item.body.kind === 'approval')
    // The prompt row names the subagent that raised it, as its other rows do.
    expect(approval?.agentId).toBe(subagentTaskId('fg-allow'))
    expect(harness.byDescription('Touch probe file')?.state).toBe('waiting')
    // One needs-input state whoever asked, its clock the request's own.
    expect(harness.publishes.at(-1)?.row).toMatchObject({
      state: 'blocked',
      stateStartedAt: approval?.observedAt,
      mainAgent: { state: 'blocked', stateStartedAt: approval?.observedAt }
    })
    expect(harness.divergences()).toEqual([])
  })

  it('names the subagent on its prompt row through the tool call when the CLI does not', async () => {
    const harness = await askedAt('fg-allow', { withoutAgentId: true })
    const approval = harness.journalItems().find((item) => item.body.kind === 'approval')
    expect(approval?.agentId).toBe(subagentTaskId('fg-allow'))
    expect(harness.publishes.at(-1)?.row?.state).toBe('blocked')
  })

  it("keeps the parent row blocked when the session's own agent asks", async () => {
    const harness = await askedAt('main-allow')
    const approval = harness.journalItems().find((item) => item.body.kind === 'approval')
    expect(approval?.agentId).toBeUndefined()
    expect(harness.publishes.at(-1)?.row).toMatchObject({
      state: 'blocked',
      mainAgent: { state: 'blocked' }
    })
  })

  it('goes back to working when the request is denied', async () => {
    const { timeline } = await replay('fg-deny')
    expect(aroundRequest(timeline)).toEqual([
      'session_state_changed -> live working',
      'can_use_tool -> live waiting',
      'deny -> live working',
      'session_state_changed -> live working'
    ])
    expect(timeline.at(-1)).toBe('success -> settled done')
  })

  it.each([
    ['declines the request', true],
    ['leaves the request to the Stop that ends it', false]
  ])('goes back to working when the user dismisses the card and Orca %s', async (_, answer) => {
    const harness = await askedAt('fg-allow')
    expect(harness.byDescription('Touch probe file')?.state).toBe('waiting')
    await harness.adapter.dismissPrompt({
      sessionId: 'session-1',
      itemId: boundCard(harness, 'fg-allow'),
      fence: 7,
      answer,
      commit: async () => hostRecordsCard(harness, { state: 'cancelled', selectedOptionId: null })
    })
    // Without an answer Claude still holds the request; the card the user closed holds no one.
    expect(harness.byDescription('Touch probe file')?.state).toBe('working')
    expect(harness.divergences()).toEqual([])
  })

  it('waits again when the host fails to record the answer', async () => {
    const harness = await askedAt('fg-allow')
    const answered = harness.adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: boundCard(harness, 'fg-allow'),
      kind: 'approval',
      response: { kind: 'option', optionId: 'allow' },
      fence: 7,
      commit: async () => {
        throw new Error('journal write failed')
      }
    })
    await expect(answered).rejects.toThrow('journal write failed')
    expect(harness.byDescription('Touch probe file')?.state).toBe('waiting')
    expect(harness.divergences()).toEqual([])
  })

  it('stops waiting when an interrupt cancels the request, then settles cancelled', async () => {
    const { timeline, subagent } = await replay('fg-interrupt')
    expect(aroundRequest(timeline)).toEqual([
      'session_state_changed -> live working',
      'can_use_tool -> live waiting',
      'interrupt -> live waiting',
      'control_cancel_request -> live working'
    ])
    // The spawn call's error result lands first and ends nothing; the child's own `killed` status
    // is what settles it, and names how it ended.
    expect(
      timeline.slice(timeline.indexOf('control_cancel_request -> live working') + 1, -1)
    ).toEqual([
      'session_state_changed -> live working',
      'user -> live working',
      'task_updated -> settled done',
      'task_notification -> settled done',
      'user -> settled done'
    ])
    expect(subagent()).toMatchObject({ membership: 'settled', outcome: 'cancelled' })
  })

  it('settles a subagent that genuinely failed as failed', async () => {
    // Captured with the subagent on a model that does not exist: its own status arrives first.
    const { timeline, subagent } = await replay('fg-fail')
    expect(timeline.find((entry) => !entry.endsWith('none'))).toBe('task_started -> live working')
    expect(subagent()).toMatchObject({
      membership: 'settled',
      outcome: 'failed',
      lastMessage: expect.stringContaining('Agent terminated early due to an API error')
    })
  })

  it('keeps a background subagent waiting after the parent turn ends, until it is allowed', async () => {
    const { timeline } = await replay('bg-allow')
    const at = timeline.indexOf('can_use_tool -> live waiting')
    expect(at).toBeGreaterThan(-1)
    // The parent's own turn ends while the background subagent is still asking.
    expect(timeline.slice(at, at + 4)).toEqual([
      'can_use_tool -> live waiting',
      'assistant -> live waiting',
      'success -> live waiting',
      'allow -> live working'
    ])
    expect(timeline.at(-1)).toBe('success -> settled done')
  })

  it('joins through the tool call it gates when the CLI does not name the subagent', async () => {
    const { timeline } = await replay('fg-allow', { withoutAgentId: true })
    expect(aroundRequest(timeline)).toEqual([
      'session_state_changed -> live working',
      'can_use_tool -> live waiting',
      'allow -> live working',
      'session_state_changed -> live working'
    ])
  })

  it('names the subagent from the request before its tool call reaches the journal', async () => {
    // The SDK answers control requests as they arrive but hands frames over in order, so a request
    // can land before the subagent's own tool call has been read.
    const harness = await startedProducer()
    const events = capturedScenario('fg-allow')
    const request = events.findIndex((event) => event.frame.type === 'control_request')
    const toolCall = events
      .slice(0, request)
      .map((event) => event.frame.type)
      .lastIndexOf('assistant')
    for (const { frame } of events.slice(0, toolCall)) {
      harness.send({ ...frame, session_id: PROVIDER_SESSION_ID })
    }
    requestFromWire(harness.claude.connections[0]!, events[request]!.frame)
    expect(harness.byDescription('Touch probe file')?.state).toBe('waiting')
  })

  it("leaves no child waiting when the session's own agent asks", async () => {
    const { timeline, records } = await replay('main-allow')
    expect(timeline.every((entry) => entry.endsWith('-> none'))).toBe(true)
    expect(records()).toEqual([])
  })
})

describe("the parent row while a subagent's request is open", () => {
  it.each(['fg-allow', 'fg-deny', 'fg-interrupt', 'bg-allow'])(
    'reads at every status publish of %s what it read before subagents waited',
    async (name) => {
      const { publishes, divergences } = await replay(name)
      expect(publishes.some((entry) => entry.childWaiting)).toBe(true)
      expect(divergences()).toEqual([])
    }
  )

  it('keeps an answered request in the rows of the subagent that asked', async () => {
    const { journalItems } = await replay('fg-allow')
    expect(journalItems().find((item) => item.body.kind === 'approval')).toMatchObject({
      agentId: subagentTaskId('fg-allow'),
      body: { resolution: { state: 'resolved', selectedOptionId: 'allow' } }
    })
  })
})

describe("a nested subagent's prompt row", () => {
  /** Root spawns agent-a, which spawns agent-n; agent-n's own Bash call is read when `toolCall`. */
  async function nested(toolCall: 'before' | 'after') {
    const harness = await startedProducer()
    const spawn = (id: string, taskId: string, parentRef: string | null) => [
      toolUse(id, 'Agent', { description: taskId, prompt: 'go' }, parentRef),
      system('task_started', {
        task_id: taskId,
        tool_use_id: id,
        description: taskId,
        task_type: 'local_agent'
      })
    ]
    const bash = toolUse('toolu_bash_n', 'Bash', { command: 'touch n' }, 'toolu_n')
    for (const frame of [
      ...spawn('toolu_a', 'agent-a', null),
      ...spawn('toolu_n', 'agent-n', 'toolu_a')
    ]) {
      harness.send(frame)
    }
    if (toolCall === 'before') {
      harness.send(bash)
    }
    invokeCanUseTool(harness.claude.connections[0]!, 'Bash', 'req-n', 'toolu_bash_n', {
      input: { command: 'touch n' },
      agentID: 'agent-n'
    })
    harness.send(toolUse('toolu_read_n', 'Read', { file_path: 'n' }, 'toolu_n'))
    return harness
  }

  const linkageOf = (item: AgentJournalProducerLinkage | undefined) => ({
    agentId: item?.agentId,
    parentAgentId: item?.parentAgentId,
    providerParentRef: item?.providerParentRef,
    producerKind: item?.producerKind,
    attempt: item?.attempt
  })

  it.each(['before', 'after'] as const)(
    "carries the linkage the agent's own rows carry, its tool call read %s the request",
    async (toolCall) => {
      const harness = await nested(toolCall)
      const items = harness.journalItems()
      const approval = items.find((item) => item.body.kind === 'approval')
      const sibling = items.find(
        (item) => item.body.kind === 'tool-call' && item.agentId === 'agent-n'
      )
      expect(linkageOf(approval)).toEqual(linkageOf(sibling))
      expect(approval).toMatchObject({ agentId: 'agent-n', parentAgentId: 'agent-a' })
    }
  )
})
