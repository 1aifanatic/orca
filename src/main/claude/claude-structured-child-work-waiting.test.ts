// A Claude subagent blocked on a permission request, replayed from a capture of the real CLI
// through the real adapter into the host's child records.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentJournalProducerLinkage } from '../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionStatusSummary } from '../../shared/structured-agent-session-projection'
import { structuredAgentSessionAgentStatus } from '../../shared/structured-agent-session-agent-status'
import { producer, system, toolUse } from './claude-child-work-producer-harness.test-fixture'
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

/** A session past startup, so no startup frame drains child work for the step under test. */
async function startedProducer() {
  const harness = await producer()
  await harness.adapter.awaitStarted('session-1')
  await new Promise((resolve) => setTimeout(resolve, 0))
  return harness
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
  return harness
}

function subagentTaskId(name: string): string {
  const started = capturedScenario(name).find((event) => event.frame.subtype === 'task_started')
  return text(started?.frame.task_id)
}

/** The parent row as the host folds it: the status summary projected from the journal, plus its
 *  children's records. */
function parentRow(harness: Awaited<ReturnType<typeof producer>>) {
  const { status, awaitsUserSince } = projectStructuredAgentSessionStatusSummary(
    harness.journalItems()
  )
  const row = structuredAgentSessionAgentStatus({
    status: status ?? 'idle',
    ...(awaitsUserSince !== undefined ? { awaitsUserSince } : {}),
    childWork: harness.records()
  })
  return { sessionStatus: status, state: row.state, mainAgent: row.mainAgent }
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
      await adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: `item-${requestId}`,
        kind: 'approval',
        response: { kind: 'option', optionId: behavior === 'deny' ? 'deny' : 'allow' },
        fence: 7,
        commit: async () => undefined
      })
      label = behavior
    } else if (from === 'orca') {
      // The interrupt itself changes nothing here; the CLI's cancel frame that follows does.
      label = text(request?.subtype)
    } else {
      send({ ...frame, session_id: PROVIDER_SESSION_ID })
    }
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

  it('reads the parent row waiting while its subagent asks, with its own state unchanged', async () => {
    const harness = await askedAt('fg-allow')
    const approval = harness.journalItems().find((item) => item.body.kind === 'approval')
    // The prompt row names the subagent that raised it, as its other rows do.
    expect(approval?.agentId).toBe(subagentTaskId('fg-allow'))
    expect(parentRow(harness)).toEqual({
      sessionStatus: 'working',
      state: 'waiting',
      mainAgent: { state: 'working' }
    })
  })

  it('names the subagent on its prompt row through the tool call when the CLI does not', async () => {
    const harness = await askedAt('fg-allow', { withoutAgentId: true })
    const approval = harness.journalItems().find((item) => item.body.kind === 'approval')
    expect(approval?.agentId).toBe(subagentTaskId('fg-allow'))
    expect(parentRow(harness).state).toBe('waiting')
  })

  it("keeps the parent row blocked when the session's own agent asks", async () => {
    const harness = await askedAt('main-allow')
    const approval = harness.journalItems().find((item) => item.body.kind === 'approval')
    expect(approval?.agentId).toBeUndefined()
    expect(parentRow(harness)).toEqual({
      sessionStatus: 'attention',
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

  it('goes back to working when the user dismisses the card and Orca declines the request', async () => {
    const harness = await askedAt('fg-allow')
    expect(harness.byDescription('Touch probe file')?.state).toBe('waiting')
    const request = capturedScenario('fg-allow').find(
      (event) => event.frame.type === 'control_request'
    )
    const requestId = text(request?.frame.request_id)
    harness.adapter.bindPromptItemId('session-1', `item-${requestId}`, requestId)
    await harness.adapter.dismissPrompt({
      sessionId: 'session-1',
      itemId: `item-${requestId}`,
      fence: 7,
      answer: true,
      commit: async () => undefined
    })
    expect(harness.byDescription('Touch probe file')?.state).toBe('working')
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
