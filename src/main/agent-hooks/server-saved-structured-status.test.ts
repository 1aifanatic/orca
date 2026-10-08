// Native chat statuses saved in `last-status.json`, beside the CLI agents' rows, so a restart can list
// them without opening any chat. Chats have no status hooks, so none of this waits on that setting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SavedStructuredSessionStatus } from '../../shared/structured-agent-session-saved-status'
import { AgentHookServer, _internals } from './server'
import { PANE, recentTs } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

const DAY_MS = 24 * 60 * 60 * 1000

let userDataPath: string
const servers: AgentHookServer[] = []

beforeEach(() => {
  _internals.resetCachesForTests()
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-saved-chat-status-'))
})

afterEach(() => {
  servers.splice(0).forEach((server) => server.stop())
  vi.restoreAllMocks()
  rmSync(userDataPath, { recursive: true, force: true })
})

function lastStatusPath(): string {
  return join(userDataPath, 'agent-hooks', 'last-status.json')
}

function readFile(): {
  entries?: Record<string, unknown>
  structuredSessions?: Record<string, unknown>
} {
  return JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
}

function writeFile(file: unknown): void {
  mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
  writeFileSync(lastStatusPath(), JSON.stringify(file), 'utf8')
}

function saved(sessionId: string, updatedAt = Date.now()): SavedStructuredSessionStatus {
  return {
    summary: {
      sessionId,
      workspaceId: 'workspace-1',
      agent: 'codex',
      status: 'working',
      latestPrompt: 'refactor the parser',
      updatedAt
    },
    turnFence: 2
  }
}

function cliEntry() {
  const receivedAt = recentTs()
  return {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    receivedAt,
    stateStartedAt: receivedAt,
    payload: { state: 'done', prompt: 'a CLI agent', agentType: 'claude' }
  }
}

async function start(statusHooksEnabled = true): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath, statusHooksEnabled })
  return server
}

describe('saved native chat statuses', () => {
  it('writes a save at once, under its own key, with no debounce to wait out', async () => {
    const server = await start()
    const entry = saved('chat-1')

    server.saveStructuredStatus(entry)

    expect(readFile()).toEqual({
      version: 2,
      entries: {},
      authorityCommitments: {},
      structuredSessions: { 'chat-1': entry }
    })
  })

  it('loads them on the next start, and drops one when its chat lets go of it', async () => {
    ;(await start()).saveStructuredStatus(saved('chat-1'))
    servers.splice(0).forEach((server) => server.stop())

    const relaunched = await start()

    expect(
      relaunched.readSavedStructuredStatuses().map((entry) => entry.summary.sessionId)
    ).toEqual(['chat-1'])
    relaunched.dropSavedStructuredStatus('chat-1')
    expect(readFile()).not.toHaveProperty('structuredSessions')
  })

  it('loads and saves with status hooks off, writing back the CLI rows it never hydrated', async () => {
    writeFile({ version: 2, entries: { [PANE]: cliEntry() }, structuredSessions: {} })
    const before = readFile().entries
    const server = await start(false)

    server.saveStructuredStatus(saved('chat-1'))

    expect(readFile().entries).toEqual(before)
    expect(Object.keys(readFile().structuredSessions ?? {})).toEqual(['chat-1'])
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('retries a save that failed when Orca quits, whatever the status-hooks setting', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const server = await start(false)
    // A directory where the file goes fails the write's rename.
    mkdirSync(lastStatusPath(), { recursive: true })
    server.saveStructuredStatus(saved('chat-1'))
    rmSync(lastStatusPath(), { recursive: true })
    expect(existsSync(lastStatusPath())).toBe(false)

    server.stop()

    expect(existsSync(lastStatusPath())).toBe(true)
    expect(Object.keys(readFile().structuredSessions ?? {})).toEqual(['chat-1'])
  })

  it('lets a save older than seven days, or a malformed one, die at load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    writeFile({
      version: 2,
      entries: {},
      structuredSessions: {
        fresh: saved('fresh'),
        expired: saved('expired', Date.now() - 8 * DAY_MS),
        'wrong-key': saved('other'),
        malformed: { summary: { sessionId: 'malformed' } }
      }
    })

    const server = await start()

    expect(server.readSavedStructuredStatuses().map((entry) => entry.summary.sessionId)).toEqual([
      'fresh'
    ])
    expect(Object.keys(readFile().structuredSessions ?? {})).toEqual(['fresh'])
  })

  it("reads an older build's file, with no chat statuses, and keeps its CLI rows", async () => {
    writeFile({ version: 2, entries: { [PANE]: cliEntry() } })

    const server = await start()

    expect(server.readSavedStructuredStatuses()).toEqual([])
    expect(server.getStatusSnapshot().map((row) => row.paneKey)).toEqual([PANE])
    server.saveStructuredStatus(saved('chat-1'))
    expect(Object.keys(readFile().entries ?? {})).toEqual([PANE])
  })
})
