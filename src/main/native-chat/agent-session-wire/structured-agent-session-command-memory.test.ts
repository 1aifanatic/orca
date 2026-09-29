// A chat whose agent is not running offers the `/` commands an agent of the same launch last
// reported: after a /clear (never started) and after the idle sweep, but never across launches.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { STRUCTURED_AGENT_SESSION_IDLE_MS } from './structured-agent-session-idle-sweep'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const caller = { callerKey: 'desktop' }
const SKILLS: AgentSessionSlashCommand[] = [{ name: 'review', kind: 'skill' }]

let directory: string
let clock: number
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquires: number
/** What each running agent reports; a session with no entry reports nothing. */
let reports: Map<string, AgentSessionSlashCommand[]>
const running = new Set<string>()

function adapter(): StructuredAgentSessionAdapter {
  return {
    supportsLocation: () => true,
    acquire: vi.fn(async (input) => {
      acquires += 1
      running.add(input.identity.sessionId)
      return {
        process: {
          hostId: 'local',
          pid: 4000 + acquires,
          processStartTimeMs: HOST_TEST_NOW,
          spawnToken: input.spawnToken
        },
        link: {
          linkId: `link-${acquires}`,
          mintedAtFence: input.fence,
          observedAt: HOST_TEST_NOW,
          origin: 'created' as const,
          handle: {
            provider: 'codex' as const,
            threadId: `00000000-0000-4000-8000-${String(acquires).padStart(12, '0')}`
          }
        }
      }
    }),
    readCommands: (sessionId) => (running.has(sessionId) ? reports.get(sessionId) : undefined),
    dispatch: vi.fn(async () => ({ state: 'unknown' as const, reason: 'test' })),
    cancelTurn: async () => ({ cancelled: true }),
    answerPrompt: async () => {},
    setOption: async () => {},
    releaseAcquisition: vi.fn(async (input) => {
      running.delete(input.sessionId)
      return true
    }),
    closeSession: vi.fn(async (sessionId) => {
      running.delete(sessionId)
      return true
    })
  }
}

beforeEach(async () => {
  resetHostTestOperationIds()
  acquires = 0
  clock = HOST_TEST_NOW
  reports = new Map()
  running.clear()
  directory = await mkdtemp(join(tmpdir(), 'orca-command-memory-'))
  store = await AgentSessionRecordStore.open({
    directory: join(directory, 'store'),
    hostId: 'local'
  })
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: directory,
    claimKeyId: 'key',
    now: () => clock,
    probeOwner: async () => ({ outcome: 'pid-absent' })
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(directory, { recursive: true, force: true })
})

async function start(
  sessionId: string,
  overrides: Parameters<typeof hostTestAttachParams>[1] = {}
): Promise<void> {
  const params = hostTestAttachParams(null, {
    ...overrides,
    envelope: {
      sessionId,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    }
  })
  expect(await host.attach(caller, params)).toMatchObject({ ok: true })
}

/** The idle sweep stops every running agent, leaving each chat at rest. */
async function idleSweep(): Promise<void> {
  clock += STRUCTURED_AGENT_SESSION_IDLE_MS + 1
  await host.collaboratorsForTests().lifetime.idleSweep.tick()
  expect(running.size).toBe(0)
}

const commandsOf = (sessionId: string) => host.readCommands(sessionId).commands

describe("a chat whose agent is not running offers its launch's last reported commands", () => {
  it('after /clear, before the new chat has started', async () => {
    await start(SESSION)
    reports.set(SESSION, SKILLS)
    expect(commandsOf(SESSION)).toEqual(SKILLS)
    const cleared = await host.conversationCommand(caller, {
      command: 'clear',
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.conversationCommand',
          sessionId: SESSION,
          fields: { command: 'clear' }
        })
      }
    })
    const replacement = cleared.ok ? cleared.value.replacementSessionId! : ''
    expect(running.has(replacement)).toBe(false)

    const events: AgentSessionSubscribeEvent[] = []
    await host.subscribe({ id: 'pane', sessionId: replacement, emit: (e) => events.push(e) })
    expect(events[0]).toMatchObject({ commands: SKILLS })
    expect(commandsOf(replacement)).toEqual(SKILLS)
  })

  it('after the idle sweep stops its agent', async () => {
    await start(SESSION)
    reports.set(SESSION, SKILLS)
    expect(commandsOf(SESSION)).toEqual(SKILLS)
    await idleSweep()
    expect(commandsOf(SESSION)).toEqual(SKILLS)
  })

  it('replaced by the newest report', async () => {
    await start(SESSION)
    reports.set(SESSION, SKILLS)
    expect(commandsOf(SESSION)).toEqual(SKILLS)
    const newer: AgentSessionSlashCommand[] = [{ name: 'deploy', kind: 'command' }]
    reports.set(SESSION, newer)
    expect(commandsOf(SESSION)).toEqual(newer)
    await idleSweep()
    expect(commandsOf(SESSION)).toEqual(newer)
  })

  it('never across accounts, workspaces or hosts, and nothing before any report', async () => {
    await start(SESSION)
    expect(commandsOf(SESSION)).toBeUndefined()
    reports.set(SESSION, SKILLS)
    expect(commandsOf(SESSION)).toEqual(SKILLS)

    await start('other-account', {
      accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex-work' }
    })
    await start('other-workspace', {
      location: { ...HOST_TEST_LOCATION, workspaceId: 'workspace-2' }
    })
    await start('other-host', {
      location: { ...HOST_TEST_LOCATION, executionHostId: 'ssh:box' }
    })
    await idleSweep()
    expect(commandsOf(SESSION)).toEqual(SKILLS)
    expect(commandsOf('other-account')).toBeUndefined()
    expect(commandsOf('other-workspace')).toBeUndefined()
    expect(commandsOf('other-host')).toBeUndefined()
  })
})
