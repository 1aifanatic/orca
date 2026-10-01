import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentStatusClearIpcPayload } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)
const CONNECTION = 'conn-a'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-row-removal-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function startServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
  return server
}

function claudeEvent(hookEventName: string, prompt = 'review the PR') {
  return {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    source: 'claude',
    hookEventName,
    launchToken: 'launch-token',
    providerSession: { key: 'session_id', id: 'resume-me' },
    payload: { state: 'working', prompt, agentType: 'claude' }
  }
}

function seedClaudeRow(server: AgentHookServer): void {
  server.ingestRemote(claudeEvent('UserPromptSubmit'), CONNECTION)
}

function liveRow(server: AgentHookServer) {
  return server.getStatusSnapshotForPane(PANE).find((row) => row.providerSessionOnly !== true)
}

/** Every channel a main-process reader can hear a removal on. */
function recordReaderNotifications(server: AgentHookServer): {
  windowClears: AgentStatusClearIpcPayload[]
  subscriberClears: AgentStatusClearIpcPayload[]
  drops: string[]
} {
  const seen: {
    windowClears: AgentStatusClearIpcPayload[]
    subscriberClears: AgentStatusClearIpcPayload[]
    drops: string[]
  } = { windowClears: [], subscriberClears: [], drops: [] }
  server.setPaneStatusClearListener((clear) => seen.windowClears.push(clear))
  server.subscribePaneStatusClear((clear) => seen.subscriberClears.push(clear))
  server.subscribeStatusDrop((paneKey) => seen.drops.push(paneKey))
  return seen
}

function clearNamesPane(clear: AgentStatusClearIpcPayload): boolean {
  return 'paneKey' in clear
    ? clear.paneKey === PANE
    : clear.transient === true && clear.connectionId === CONNECTION
}

// Why: a reader that keeps a row the host deleted is the bug class. Every host operation that
// removes a live row must tell readers in the same step, whoever started it.
const REMOVALS: Record<string, (server: AgentHookServer) => void> = {
  dropStatusEntry: (server) => server.dropStatusEntry(PANE),
  dropPersistedStatusEntry: (server) => {
    const row = liveRow(server)!
    server.dropPersistedStatusEntry({
      paneKey: PANE,
      stateStartedAt: row.stateStartedAt,
      receivedAt: row.receivedAt
    })
  },
  clearPaneState: (server) => server.clearPaneState(PANE),
  reconcileEndedProcessForPaneKeys: (server) => {
    server.reconcileEndedProcessForPaneKeys([PANE], { preserveResumeIdentity: true })
  },
  dropStatusEntriesByTabPrefix: (server) => server.dropStatusEntriesByTabPrefix('tab-1'),
  clearStatusEntriesForConnection: (server) => server.clearStatusEntriesForConnection(CONNECTION),
  'retirePaneAuthority (renderer pane close)': (server) => server.retirePaneAuthority(PANE),
  'retirePaneAuthority (runtime command end)': (server) =>
    server.retirePaneAuthority(PANE, undefined, { preserveResumeIdentity: true })
}

describe('every host row removal notifies readers', () => {
  for (const [name, remove] of Object.entries(REMOVALS)) {
    it(name, async () => {
      const server = await startServer()
      try {
        seedClaudeRow(server)
        expect(liveRow(server)?.state).toBe('working')
        const seen = recordReaderNotifications(server)

        remove(server)

        expect(liveRow(server)).toBeUndefined()
        const subscribersHeard =
          seen.subscriberClears.some(clearNamesPane) || seen.drops.includes(PANE)
        expect(subscribersHeard).toBe(true)
      } finally {
        server.stop()
      }
    })
  }
})

describe('retirePaneAuthority', () => {
  it('tells the desktop window and every pane-clear subscriber about each row it removes', async () => {
    const server = await startServer()
    try {
      seedClaudeRow(server)
      const seen = recordReaderNotifications(server)

      server.retirePaneAuthority(PANE, undefined, { preserveResumeIdentity: true })

      expect(seen.windowClears).toEqual([{ paneKey: PANE }])
      expect(seen.subscriberClears).toEqual([{ paneKey: PANE }])
    } finally {
      server.stop()
    }
  })

  it('stays silent for a pane that held no row', async () => {
    const server = await startServer()
    try {
      const seen = recordReaderNotifications(server)

      server.retirePaneAuthority(PANE, undefined, { preserveResumeIdentity: true })

      expect(seen.windowClears).toEqual([])
      expect(seen.subscriberClears).toEqual([])
    } finally {
      server.stop()
    }
  })

  it('keeps the resume identity on a command end, as the ended-process clear does', async () => {
    const server = await startServer()
    try {
      seedClaudeRow(server)

      server.retirePaneAuthority(PANE, undefined, { preserveResumeIdentity: true })

      const rows = server.getStatusSnapshotForPane(PANE)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.providerSessionOnly).toBe(true)
      expect(rows[0]?.providerSession?.id).toBe('resume-me')
      expect(rows[0]?.launchToken).toBeUndefined()

      // The fence still holds: a late event from the exited process cannot repaint the pane.
      server.ingestRemote(claudeEvent('PostToolUse'), CONNECTION)
      expect(liveRow(server)).toBeUndefined()
      // A new turn proves a new process owns the pane and replaces the remnant.
      server.ingestRemote(claudeEvent('UserPromptSubmit', 'next task'), CONNECTION)
      expect(liveRow(server)?.prompt).toBe('next task')

      // The remnant must not bring back retired launch authority after a restart.
      server.retirePaneAuthority(PANE, undefined, { preserveResumeIdentity: true })
      server.flushStatusPersistSync()
      server.stop()
      const restarted = await startServer()
      expect(restarted.getStatusSnapshotForPane(PANE)[0]?.launchToken).toBeUndefined()
      expect(restarted.getHydratedAuthorityCommitments()).toHaveLength(0)
      restarted.stop()
    } finally {
      server.stop()
    }
  })

  it('on a command end ends only launch authority: the row, its fence and its readers stay', async () => {
    const server = await startServer()
    try {
      seedClaudeRow(server)
      const seen = recordReaderNotifications(server)
      const attest = () =>
        server.attestCompatibilityAuthority({
          paneKey: PANE,
          launchTokenHash: createHash('sha256').update('launch-token').digest('hex'),
          connectionId: CONNECTION,
          terminalProvenance: 'current_runtime'
        })
      expect(attest()).not.toBeNull()

      server.retirePaneAuthority(PANE, undefined, { authorityOnly: true })

      expect(liveRow(server)?.state).toBe('working')
      expect(liveRow(server)?.launchToken).toBeUndefined()
      expect(attest()).toBeNull()
      expect(seen.windowClears).toEqual([])
      expect(seen.subscriberClears).toEqual([])
      // Not fenced: the live agent's next event still lands.
      server.ingestRemote(claudeEvent('PostToolUse', 'still going'), CONNECTION)
      expect(liveRow(server)?.prompt).toBe('still going')
    } finally {
      server.stop()
    }
  })

  it('takes the resume identity too when no shell is left to resume into', async () => {
    const server = await startServer()
    try {
      seedClaudeRow(server)

      server.retirePaneAuthority(PANE)

      expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
    } finally {
      server.stop()
    }
  })
})
