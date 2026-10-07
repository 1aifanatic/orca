// A chat's permission mode on the host: what it reports at rest, what it accepts, and the
// relaunch a send makes when the running child cannot honour the chat's mode.

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { CLAUDE_STRUCTURED_AGENT } from '../../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import {
  readStructuredAgentSessionOptions,
  recordStructuredAgentSessionOptionIntent
} from './structured-agent-session-options-read'
import { relaunchOutgrownStructuredAgentSessionChild } from './structured-agent-session-child-relaunch'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

const SESSION = 'session-1'

function record(provider: string, options: Record<string, string> = {}): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read and intent write touch only these fields.
  return {
    provider,
    accountHome: { variable: 'CODEX_HOME', path: '/homes/a' },
    location: { wslDistro: null },
    options
  } as unknown as AgentSessionRecord
}

function restingRead(
  value: AgentSessionRecord,
  defaultPermissionMode?: (agent: string) => 'ask' | 'bypass' | null
) {
  const resting = { child: null, params: { provider: value.provider } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read touches only these members.
  const context = {
    deps: {
      adapter: {},
      agents: NO_STRUCTURED_AGENTS,
      store: { getRecord: () => value },
      ...(defaultPermissionMode ? { defaultPermissionMode } : {})
    },
    serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => resting,
    conversation: async () => resting
  } as unknown as StructuredAgentSessionMutationContext
  return readStructuredAgentSessionOptions(context, SESSION)
}

describe('a chat permission mode at rest', () => {
  it('reports the chat its own stored mode over the setting', async () => {
    await expect(
      restingRead(record('claude', { permissionMode: 'accept-edits' }), () => 'bypass')
    ).resolves.toMatchObject({
      permissionModes: {
        current: 'accept-edits',
        supported: ['ask', 'accept-edits', 'auto', 'bypass']
      }
    })
  })

  it('reports where the setting starts a chat that never chose', async () => {
    await expect(restingRead(record('codex'), () => 'bypass')).resolves.toMatchObject({
      permissionModes: { current: 'bypass', supported: ['ask', 'auto', 'bypass'] }
    })
  })

  it('reports nothing when neither the chat nor the host can name a mode', async () => {
    const result = await restingRead(record('codex'))
    expect(result).not.toHaveProperty('permissionModes')
  })
})

describe('a chat permission-mode pick at rest', () => {
  const deps = (value: AgentSessionRecord) => ({
    store: { getRecord: () => value },
    agents: {
      definition: (agent: string) =>
        agent === 'codex' ? CODEX_STRUCTURED_AGENT : CLAUDE_STRUCTURED_AGENT
    }
  })
  const ctx = () => ({
    sessionId: SESSION,
    persistOptions: vi.fn(async () => {}),
    publish: vi.fn()
  })

  it('records a mode the agent can run as the next start intent', async () => {
    const turn = ctx()
    const value = record('codex', { model: 'gpt-live' })
    await expect(
      recordStructuredAgentSessionOptionIntent(deps(value), turn, {
        key: 'permissionMode',
        value: 'auto'
      })
    ).resolves.toMatchObject({ ok: true })
    expect(turn.persistOptions).toHaveBeenCalledWith({ model: 'gpt-live', permissionMode: 'auto' })
  })

  it('refuses a mode the agent has no equivalent for', async () => {
    const turn = ctx()
    await expect(
      recordStructuredAgentSessionOptionIntent(deps(record('codex')), turn, {
        key: 'permissionMode',
        value: 'accept-edits'
      })
    ).resolves.toMatchObject({ ok: false })
    expect(turn.persistOptions).not.toHaveBeenCalled()
  })
})

const LOGGER: StructuredAgentSessionLogger = recordingStructuredAgentSessionLogger().logger

function liveSession(
  overrides: {
    activeTurnId?: string | null
    phase?: 'starting' | 'ready'
    pendingPrompt?: boolean
  } = {}
): StructuredAgentSessionHostSession {
  const items = overrides.pendingPrompt
    ? [{ body: { kind: 'approval', resolution: { state: 'pending' } } }]
    : []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relaunch check reads only the child and these journal members.
  return {
    child: { generation: 'g1', fence: 1, phase: overrides.phase ?? 'ready' },
    journal: {
      activeTurnId: () => overrides.activeTurnId ?? null,
      snapshot: () => ({ items })
    }
  } as unknown as StructuredAgentSessionHostSession
}

function relaunch(
  session: StructuredAgentSessionHostSession,
  adapter: { childRelaunchRequired?: () => boolean; holdsDispatch?: () => boolean }
) {
  const restChild = vi.fn(async () => {})
  const run = relaunchOutgrownStructuredAgentSessionChild(
    { session, adapter, childWork: undefined, restChild, logger: LOGGER },
    SESSION
  )
  return { restChild, run }
}

describe('relaunching a child the chat outgrew before a send', () => {
  it('puts an idle outgrown child to rest so the send starts one under the new launch', async () => {
    const { restChild, run } = relaunch(liveSession(), { childRelaunchRequired: () => true })
    await run
    expect(restChild).toHaveBeenCalledOnce()
  })

  it('leaves a child alone that still fits the chat', async () => {
    const { restChild, run } = relaunch(liveSession(), { childRelaunchRequired: () => false })
    await run
    expect(restChild).not.toHaveBeenCalled()
  })

  // No mid-turn interruption: a send into a running turn steers it under the old launch.
  it.each([
    ['a running turn', liveSession({ activeTurnId: 'turn-1' }), {}],
    ['a pending prompt', liveSession({ pendingPrompt: true }), {}],
    ['a start not yet proven', liveSession({ phase: 'starting' }), {}],
    ['a send the provider still holds', liveSession(), { holdsDispatch: () => true }]
  ] as const)('keeps an outgrown child that owes %s', async (_label, session, extra) => {
    const { restChild, run } = relaunch(session, { childRelaunchRequired: () => true, ...extra })
    await run
    expect(restChild).not.toHaveBeenCalled()
  })

  it('still lets the send go when the child will not stop', async () => {
    const restChild = vi.fn(async () => {
      throw new Error('exit not proven')
    })
    await expect(
      relaunchOutgrownStructuredAgentSessionChild(
        {
          session: liveSession(),
          adapter: { childRelaunchRequired: () => true },
          childWork: undefined,
          restChild,
          logger: LOGGER
        },
        SESSION
      )
    ).resolves.toBeUndefined()
  })
})
