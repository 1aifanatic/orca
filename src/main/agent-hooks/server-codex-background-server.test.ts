// Codex's shared background server runs a TUI's turn and subagents in its own process, so that work
// outlives the TUI; an embedded Codex runs them in the TUI. The execution host reports which, from
// the server's own pid record, and ends the work once that server is gone.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f316f'
// Above every platform's pid ceiling, so signalling it always reports no such process.
const DEAD_PID = 2_147_483_646

function turnMarker(type: string, turnId: string): string {
  return `${JSON.stringify({ type: 'event_msg', payload: { type, turn_id: turnId } })}\n`
}

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

describe("a Codex row's session process", () => {
  let home: string
  let dayDir: string
  let rollout: string
  let server: AgentHookServer

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'codex-home-'))
    dayDir = join(home, 'sessions', '2026', '09', '27')
    mkdirSync(dayDir, { recursive: true })
    mkdirSync(join(home, 'app-server-daemon'))
    rollout = join(dayDir, 'rollout-2026-09-27T10-00-00-root.jsonl')
    writeFileSync(rollout, turnMarker('task_started', 'turn-1'))
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
    rmSync(home, { recursive: true, force: true })
  })

  function recordServerPid(pid: number): void {
    writeFileSync(join(home, 'app-server-daemon', 'daemon.pid'), JSON.stringify({ pid }))
  }

  async function post(payload: Record<string, unknown>): Promise<void> {
    await expect(
      postHookEvent(
        server,
        buildBody({ session_id: 'root-session', transcript_path: rollout, ...payload }),
        '/hook/codex'
      )
    ).resolves.toMatchObject({ status: 204 })
  }

  it('is the TUI when no background server runs for the Codex home', async () => {
    recordServerPid(DEAD_PID)
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    const row = server.getStatusSnapshot()[0]
    expect(row).toMatchObject({ state: 'working' })
    expect(row?.sessionRunner).toBeUndefined()
  })

  it('is the background server while it runs, and a row that settles stops naming it', async () => {
    recordServerPid(process.pid)
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      sessionRunner: 'background-server'
    })
    await post({ hook_event_name: 'Stop', turn_id: 'turn-1' })
    expect(server.getStatusSnapshot()[0]?.sessionRunner).toBeUndefined()
  })

  // A server killed mid-turn writes no end marker, so its turn and subagents end with it.
  it('ends the turn and subagents the server ran once it is gone', async () => {
    writeFileSync(
      join(dayDir, `rollout-2026-09-27T10-00-05-${CHILD_ID}.jsonl`),
      turnMarker('task_started', 'child-turn')
    )
    recordServerPid(process.pid)
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    await post({ hook_event_name: 'SubagentStart', agent_id: CHILD_ID, turn_id: 'child-turn' })
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      sessionRunner: 'background-server',
      subagents: [expect.objectContaining({ id: CHILD_ID, state: 'working' })]
    })

    recordServerPid(DEAD_PID)
    await vi.waitFor(
      () => {
        expect(server.getStatusSnapshot()[0]).toMatchObject({
          state: 'done',
          interrupted: true,
          mainAgent: { state: 'done', outcome: 'cancellation' }
        })
      },
      { timeout: 3_000, interval: 50 }
    )
    const row = server.getStatusSnapshot()[0]
    expect(row?.subagents).toBeUndefined()
    expect(row?.sessionRunner).toBeUndefined()
  })
})

describe("a relayed Codex row's session process", () => {
  it('keeps what the relay, which can see the remote Codex home, reported', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          source: 'codex',
          hookEventName: 'UserPromptSubmit',
          payload: {
            state: 'working',
            prompt: 'go',
            agentType: 'codex',
            sessionRunner: 'background-server',
            mainAgent: { state: 'working', stateStartedAt: 1 }
          }
        },
        'conn-a'
      )
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        sessionRunner: 'background-server'
      })
    } finally {
      server.stop()
    }
  })
})
