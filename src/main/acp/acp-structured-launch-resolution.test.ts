import { describe, expect, it } from 'vitest'
import {
  agentSessionProviderHandleKey,
  type AgentSessionProviderHandle
} from '../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { JournalLoad } from '../native-chat/agent-session-journal/journal-open'
import { createJournalReducerState } from '../native-chat/agent-session-journal/journal-reducer'
import { spellProviderTimelineKey } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import { createProviderSpawnSpec } from '../provider-process/provider-process-supervisor'
import { ACP_CHILD_ENV_TO_DELETE, acpLaunchSpecFor } from './acp-launch-specs'
import { createAcpStructuredLaunchResolver } from './acp-structured-launch-resolution'

const GROK = acpLaunchSpecFor('grok')!
const identity = {
  sessionId: 'session-alpha-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'grok',
  providerHandle: null
}

function grokRecord(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(),
    provider: 'grok',
    providerHandleChain: [],
    accountHome: { variable: 'GROK_HOME', path: '/home/user/.grok-work' },
    ...overrides
  }
}

/** A journal holding one turn of each named provider session. */
function journalWithTurns(...providerSessions: string[]): JournalLoad {
  const state = createJournalReducerState(identity.sessionId, 'epoch-1')
  providerSessions.forEach((providerSession, index) => {
    const turnId = spellProviderTimelineKey(providerSession, {
      source: 'provider',
      value: `prompt:m${index}`
    })
    state.items.set(`turn-${index}`, {
      itemId: `turn-${index}`,
      revision: 1,
      sequence: index + 2,
      observedAt: 1,
      body: { kind: 'turn', turnId, state: 'completed' }
    })
  })
  return { state, newer: null, damage: null }
}

function resolver(
  record: AgentSessionRecord,
  fullAccess = false,
  readJournal: () => JournalLoad | null = () => null
) {
  const searched: (string | null | undefined)[] = []
  return {
    searched,
    resolve: createAcpStructuredLaunchResolver(GROK, {
      store: { getRecord: () => record },
      readJournal,
      resolveWorkspacePath: async () => '/repo/worktree',
      resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
      resolveLaunchEnv: () => ({ GROK_EXTRA: '1' }),
      resolveFullAccess: () => fullAccess,
      resolveCommand: (command, options) => {
        searched.push(options?.pathEnv)
        return `/resolved/${command}`
      }
    })
  }
}

describe('ACP launch resolution', () => {
  it('pins the record account home and searches the agent install dir', async () => {
    const { resolve, searched } = resolver(grokRecord())
    const launch = await resolve({ identity })
    expect(launch).toMatchObject({
      command: '/resolved/grok',
      args: ['agent', 'stdio'],
      cwd: '/repo/worktree',
      fullAccess: false,
      resume: null
    })
    expect(launch.env).toMatchObject({
      GROK_HOME: '/home/user/.grok-work',
      GROK_EXTRA: '1'
    })
    expect(searched[0]).toContain('/home/user/.grok-work/bin')
  })

  it('asks the agent to approve everything only under full access', async () => {
    const launch = await resolver(grokRecord(), true).resolve({ identity })
    expect(launch.args).toContain('--always-approve')
  })

  it('resumes the chain head by its key, possibly unsaved only when this chat created it', async () => {
    const link = (origin: 'created' | 'resumed') => ({
      linkId: `link-${origin}`,
      origin,
      mintedAtFence: 1,
      observedAt: 1,
      handle: { transport: 'acp', agent: 'grok', nativeId: 'acp-1' }
    })
    const created = await resolver(grokRecord({ providerHandleChain: [link('created')] })).resolve({
      identity
    })
    const handle: AgentSessionProviderHandle = {
      transport: 'acp',
      agent: 'grok',
      nativeId: 'acp-1'
    }
    const key = agentSessionProviderHandleKey(handle)
    expect(created.resume).toMatchObject({ sessionId: 'acp-1', key })
    expect(created.resume?.mayBeUnsaved()).toBe(true)
    const resumed = await resolver(
      grokRecord({ providerHandleChain: [link('created'), link('resumed')] }),
      false,
      () => journalWithTurns()
    ).resolve({ identity })
    expect(resumed.resume).toMatchObject({ sessionId: 'acp-1', key })
    expect(resumed.resume?.mayBeUnsaved()).toBe(false)
  })

  it('counts a created session as possibly unsaved only while the journal proves no turn on it', async () => {
    const created = grokRecord({
      providerHandleChain: [
        {
          linkId: 'link-created',
          origin: 'created',
          mintedAtFence: 1,
          observedAt: 1,
          handle: { transport: 'acp', agent: 'grok', nativeId: 'acp-1' }
        }
      ]
    })
    const unsaved = async (readJournal: () => JournalLoad | null) =>
      (await resolver(created, false, readJournal).resolve({ identity })).resume?.mayBeUnsaved()
    const reads: string[] = []
    const launch = await resolver(created, false, () => {
      reads.push('read')
      return null
    }).resolve({ identity })
    // Read only when asked: a reopen that works never replays the journal.
    expect(reads).toEqual([])
    expect(launch.resume?.mayBeUnsaved()).toBe(true)

    expect(await unsaved(() => journalWithTurns())).toBe(true)
    expect(await unsaved(() => journalWithTurns('acp-other'))).toBe(true)
    expect(await unsaved(() => journalWithTurns('acp-other', 'acp-1'))).toBe(false)
    // A journal that does not read whole, or at all, proves nothing.
    expect(
      await unsaved(() => ({
        ...journalWithTurns(),
        damage: { sequence: 3, cause: 'sequence-gap' }
      }))
    ).toBe(false)
    expect(await unsaved(() => ({ ...journalWithTurns(), newer: { sequence: 3 } }))).toBe(false)
    expect(
      await unsaved(() => {
        throw new Error('journal_closed')
      })
    ).toBe(false)
  })

  it('refuses a record pinned to another host or another agent', async () => {
    const remote = grokRecord()
    remote.location = { ...remote.location, executionHostId: 'ssh:box' }
    await expect(resolver(remote).resolve({ identity })).rejects.toThrow(/run on this runtime/)
    await expect(resolver(agentSessionRecordFixture()).resolve({ identity })).rejects.toThrow(
      /claude session/
    )
  })
})

describe('Grok status: the structured session is the only producer', () => {
  it('strips every pane identity and hook endpoint an inherited environment carries', () => {
    const inherited = {
      PATH: '/usr/bin',
      ORCA_PANE_KEY: 'tab-1:pane-1',
      ORCA_AGENT_PANE: 'tab-1:pane-1',
      ORCA_TAB_ID: 'tab-1',
      ORCA_WORKTREE_ID: 'wt-1',
      ORCA_AGENT_LAUNCH_TOKEN: 'launch-1',
      ORCA_AGENT_HOOK_PORT: '4321',
      ORCA_AGENT_HOOK_TOKEN: 'secret',
      ORCA_AGENT_HOOK_ENDPOINT: '/tmp/endpoint'
    }
    const spec = createProviderSpawnSpec(
      {
        command: 'grok',
        args: ['agent', 'stdio'],
        env: { GROK_HOME: '/home/user/.grok' },
        envToDelete: ACP_CHILD_ENV_TO_DELETE
      },
      inherited,
      'win32'
    )
    expect(Object.keys(spec.env).filter((key) => key.startsWith('ORCA_'))).toEqual([])
    expect(spec.env).toMatchObject({ PATH: '/usr/bin', GROK_HOME: '/home/user/.grok' })
  })
})
