// The Claude transcript watch's machinery on the desktop host, through the server's own HTTP
// ingress. Built from the Claude Code 2.1.280 idle Ctrl+C capture
// (src/shared/__fixtures__/claude-idle-ctrl-c-bg-agent-hooks.jsonl): its hook bodies and its one
// captured `agents_killed` transcript line. Bodies marked "hand-built" are captured bodies with
// fields changed, or events placed at times the capture did not record; each test says which.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { cancelLabelled, hookAt, loadCapture } from './claude-cancel-capture.test-fixture'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const records = loadCapture('claude-idle-ctrl-c-bg-agent-hooks')
const scan = records.find((record) => record.kind === 'transcript')
const KILL_LINE = scan?.kind === 'transcript' ? scan.lines[0] : undefined
if (!KILL_LINE) {
  throw new Error('the capture has no agents_killed line')
}
// JSON.parse returns any; Date.parse checks the one field read.
const KILL_ROW: Record<string, unknown> = JSON.parse(KILL_LINE)
const KILLED_AT = Date.parse(String(KILL_ROW.timestamp))
const T0 = KILLED_AT - cancelLabelled(records, 'CTRL-C-idle-with-bg-shell-and-bg-agent').t * 1000
const CHILD = 'a2303994f3dfae83c'
/** Enough real time for the watch to have ticked at least twice. */
const TWO_TICKS_MS = 2_300

const temporaryPaths: string[] = []
const running: AgentHookServer[] = []

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  // Why: the roster and the cancel latch read Date; the watch's ticks stay on real timers.
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  for (const server of running.splice(0)) {
    server.stop()
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function transcriptFile(content = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-claude-transcript-watch-'))
  temporaryPaths.push(dir)
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, content)
  return path
}

async function startServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  running.push(server)
  await server.start({ env: 'production' })
  return server
}

function row(server: AgentHookServer) {
  const entry = server.getStatusSnapshotForPane(PANE)[0]
  if (!entry) {
    throw new Error('the pane has no row')
  }
  return entry
}

function cursor(server: AgentHookServer) {
  return server._getStateForTests().claudeTranscriptCursorByPaneKey.get(PANE)
}

async function post(server: AgentHookServer, payload: Record<string, unknown>): Promise<void> {
  await expect(postHookEvent(server, buildBody(payload))).resolves.toMatchObject({ status: 204 })
}

/** Captured hooks on the capture's clock, each naming `transcript` as its session file. */
async function replay(server: AgentHookServer, transcript: string, indices: number[]) {
  for (const index of indices) {
    const hook = hookAt(records, index)
    vi.setSystemTime(T0 + hook.t * 1000)
    await post(server, { ...hook.payload, transcript_path: transcript })
  }
}

function pressCtrlC(server: AgentHookServer): boolean {
  const baseline = row(server)
  return server.inferInterrupt({
    paneKey: PANE,
    baselineUpdatedAt: baseline.receivedAt,
    baselineStateStartedAt: baseline.stateStartedAt,
    baselinePrompt: baseline.prompt,
    baselineAgentType: 'claude',
    intent: 'ctrl-c'
  })
}

/** Only Date is faked, so this waits on the same real timers the watch ticks on. */
function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Ctrl+C while the captured second turn runs, with its background agent working. */
async function cancelledWithWorkingChild(server: AgentHookServer, transcript: string) {
  await replay(server, transcript, [0, 1, 2, 3, 4, 5, 6, 7, 8])
  expect(pressCtrlC(server)).toBe(true)
  expect(row(server)).toMatchObject({
    state: 'working',
    mainAgent: { state: 'done', outcome: 'cancellation' },
    subagents: [expect.objectContaining({ id: CHILD, state: 'working' })]
  })
  return row(server)
}

/** Hand-built timing: the captured main-agent PostToolUse, delivered again after the Ctrl+C. */
function lateMainAgentPostToolUse(transcript: string): Record<string, unknown> {
  return { ...hookAt(records, 7).payload, transcript_path: transcript }
}

describe('catch-up before every Claude event', () => {
  it("applies a fact the transcript already holds before the next hook, so that hook's own row shows it", async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    await replay(server, transcript, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(row(server).subagents).toEqual([
      expect.objectContaining({ id: CHILD, state: 'working' })
    ])
    // Hand-built timing: the next typed prompt lands before any tick could read the kill line.
    vi.setSystemTime(KILLED_AT + 120)
    appendFileSync(transcript, `${KILL_LINE}\n`)
    await replay(server, transcript, [11])
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    expect(row(server).subagents).toBeUndefined()
  })

  it('publishes a fact read before an event that produced no row, on the next tick', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    await replay(server, transcript, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    vi.setSystemTime(KILLED_AT + 120)
    appendFileSync(transcript, `${KILL_LINE}\n`)
    // Hand-built: an auto compact's PostCompact, which maps to no row.
    await post(server, {
      ...hookAt(records, 9).payload,
      transcript_path: transcript,
      hook_event_name: 'PostCompact',
      trigger: 'auto',
      background_tasks: undefined
    })
    expect(row(server).subagents).toEqual([
      expect.objectContaining({ id: CHILD, state: 'working' })
    ])
    expect(cursor(server)?.offset).toBe(KILL_LINE.length + 1)
    await vi.waitFor(() => expect(row(server).subagents).toBeUndefined(), { timeout: 3_000 })
    expect(row(server)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' }
    })
  })
})

describe('the tick against the cancel latch (W1)', () => {
  it('keeps the cancel after the latch window when the latch held a late main-agent hook', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    const cancelled = await cancelledWithWorkingChild(server, transcript)
    vi.setSystemTime(Date.now() + 100)
    await post(server, lateMainAgentPostToolUse(transcript))
    // The latch holds tool progress after the cancel.
    expect(row(server)).toEqual(cancelled)
    // Past the 15 s window, the watch keeps ticking while the child works.
    vi.setSystemTime(Date.now() + 20_000)
    await realDelay(TWO_TICKS_MS)
    expect(row(server)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' },
      subagents: [expect.objectContaining({ id: CHILD, state: 'working' })]
    })
    expect(server._getStateForTests().claudeLeadStateByPaneKey.get(PANE)).toMatchObject({
      state: 'done',
      outcome: 'cancellation',
      stateStartedAt: cancelled.mainAgent?.stateStartedAt
    })
  })
})

describe('who may move the cursor', () => {
  it('ignores the transcript path of an event the store refused', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    await cancelledWithWorkingChild(server, transcript)
    // Hand-built: a late main-agent hook naming another transcript; the latch refuses it.
    const other = transcriptFile()
    vi.setSystemTime(Date.now() + 100)
    await post(server, lateMainAgentPostToolUse(other))
    expect(cursor(server)?.filePath).toBe(transcript)
    vi.setSystemTime(KILLED_AT + 120)
    appendFileSync(transcript, `${KILL_LINE}\n`)
    await vi.waitFor(() => expect(row(server).subagents).toBeUndefined(), { timeout: 3_000 })
    expect(row(server)).toMatchObject({ mainAgent: { state: 'done', outcome: 'cancellation' } })
  })

  it('follows an accepted nested `claude -p` to its own file and misses the outer rows meanwhile (W2)', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    await replay(server, transcript, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    // Hand-built: a nested `claude -p` in the pane inherits its key; its subagent's start is
    // accepted and names the nested session's own transcript.
    const nested = transcriptFile()
    await post(server, {
      ...hookAt(records, 8).payload,
      session_id: '00000000-0000-4000-8000-0000000000aa',
      transcript_path: nested,
      agent_id: 'anested00000000001'
    })
    expect(cursor(server)?.filePath).toBe(nested)
    vi.setSystemTime(KILLED_AT + 120)
    appendFileSync(transcript, `${KILL_LINE}\n`)
    await realDelay(TWO_TICKS_MS)
    // The outer session's own next event repoints at the outer file's end, past the kill line.
    await replay(server, transcript, [11])
    await realDelay(TWO_TICKS_MS)
    // Lingers, the safe direction: the killed child still reads working until an inventory.
    expect(row(server).subagents).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: CHILD, state: 'working' })])
    )
  })
})

describe('a session change on the pane', () => {
  it('repoints to the new session file at /clear, and disarms only after a read', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    await replay(server, transcript, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    // Hand-built: /clear's SessionStart (source `clear`) for a new session and its own file.
    const cleared = transcriptFile('{"type":"user","copied":true}\n')
    await post(server, {
      ...hookAt(records, 0).payload,
      session_id: '00000000-0000-4000-8000-0000000000c1',
      transcript_path: cleared,
      source: 'clear'
    })
    // The session change moves the cursor and keeps what it watched for; the records' own
    // SessionStart reset then ends this reason, which only the next read acts on.
    expect(cursor(server)).toMatchObject({
      filePath: cleared,
      offset: '{"type":"user","copied":true}\n'.length,
      reasons: new Set(['agent-child-working'])
    })
    await vi.waitFor(() => expect(cursor(server)).toBeUndefined(), { timeout: 3_000 })
  })
})

describe('the tick against the permission hold (W3, main without #22042)', () => {
  it("re-offers nothing visible while the store keeps a main agent's permission card", async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    await replay(server, transcript, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    // Hand-built: a third turn asks permission for one call while a parallel sibling completes.
    const base = { ...hookAt(records, 6).payload, transcript_path: transcript }
    const turn = { prompt_id: '00000000-0000-4000-8000-0000000000b1' }
    const gated = { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }
    await post(server, { ...base, ...turn, hook_event_name: 'UserPromptSubmit', prompt: 'clean' })
    await post(server, {
      ...base,
      ...turn,
      ...gated,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'toolu_gated'
    })
    await post(server, {
      ...base,
      ...turn,
      ...gated,
      hook_event_name: 'PermissionRequest',
      tool_use_id: undefined
    })
    await post(server, {
      ...base,
      ...turn,
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
      tool_use_id: 'toolu_sibling'
    })
    const held = row(server)
    expect(held).toMatchObject({ state: 'waiting', toolName: 'Bash' })
    // The listener's record says the main agent works; the store keeps the card.
    expect(server._getStateForTests().claudeLeadStateByPaneKey.get(PANE)?.state).toBe('working')
    vi.setSystemTime(Date.now() + 20_000)
    await realDelay(TWO_TICKS_MS)
    expect(cursor(server)).toBeDefined()
    expect(row(server)).toEqual(held)
  })
})

describe('other writers of the stored row, on an armed pane', () => {
  it('leaves an inferred question answer as it published it', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    await replay(server, transcript, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    // Hand-built: a third turn asks an AskUserQuestion, answered by a typed Escape.
    const base = { ...hookAt(records, 6).payload, transcript_path: transcript }
    await post(server, {
      ...base,
      prompt_id: 'p-q',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'ask'
    })
    await post(server, {
      ...base,
      prompt_id: 'p-q',
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which?' }] },
      tool_use_id: 'toolu_q'
    })
    expect(row(server)).toMatchObject({ state: 'waiting', toolName: 'AskUserQuestion' })
    const baseline = row(server)
    expect(
      server.inferQuestionAnswered({
        paneKey: PANE,
        baselineUpdatedAt: baseline.receivedAt,
        baselineStateStartedAt: baseline.stateStartedAt,
        baselinePrompt: baseline.prompt,
        baselineAgentType: 'claude'
      })
    ).toBe(true)
    const answered = row(server)
    await realDelay(TWO_TICKS_MS)
    expect(row(server)).toEqual(answered)
  })

  it('restates the children an OSC repaint dropped, within a tick instead of at the next hook', async () => {
    // The one census writer whose row the watch changes; Claude reports by HTTP hooks, so this
    // needs something else in the pane to print an OSC 9999 status.
    const server = await startServer()
    const transcript = transcriptFile()
    await replay(server, transcript, [0, 1, 2, 3, 4, 5, 6, 7, 8])
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      payload: { state: 'working', prompt: 'osc', agentType: 'claude' }
    })
    expect(row(server).subagents).toBeUndefined()
    await vi.waitFor(
      () =>
        expect(row(server).subagents).toEqual([
          expect.objectContaining({ id: CHILD, state: 'working' })
        ]),
      { timeout: 3_000 }
    )
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
  })
})
