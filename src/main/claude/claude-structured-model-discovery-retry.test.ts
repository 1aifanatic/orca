import { describe, expect, it } from 'vitest'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { claudeAcquireCatalogAccess } from './claude-structured-acquire-catalog'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type { openClaudeStreamJsonConnection } from './claude-stream-json-connection'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  claudeStartupSettled,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  recordingJournalSink,
  USER_MESSAGE
} from './claude-structured-session-test-support'

const ACCOUNT_HOME = '/accounts/claude'
const SAVED_MODEL = {
  id: 'account-model',
  label: 'Account model',
  isDefault: true,
  efforts: [{ value: 'high', label: 'High' }],
  defaultEffort: 'high',
  supportsFastMode: false
}

function fixture(
  saved: boolean,
  listing: 'empty' | 'error',
  openConnection?: typeof openClaudeStreamJsonConnection
) {
  const store = new AgentModelCatalogStore()
  const access = claudeAcquireCatalogAccess(store, ACCOUNT_HOME)
  if (!access) {
    throw new Error('the account has a catalog key')
  }
  if (saved) {
    store.recordSuccess(access.fingerprint, 'claude', {
      models: [SAVED_MODEL],
      fastModeTierByModel: new Map(),
      origin: 'probe'
    })
  }
  const claude = fakeClaude({
    initModels: [],
    ...(saved
      ? { settings: { applied: { model: SAVED_MODEL.id, effort: 'high' }, effective: {} } }
      : {}),
    routes: {
      list_models: () => {
        if (listing === 'error') {
          throw new Error('temporarily unavailable')
        }
        return []
      }
    }
  })
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/folder',
      claudeConfigDir: ACCOUNT_HOME,
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    onEvent: (event) => events.push(event),
    openConnection: openConnection ?? claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    persistHandle: async () => {},
    modelCatalog: store
  })
  return { store, access, claude, events, adapter }
}

describe('Claude chats with unavailable model discovery', () => {
  it.each(['empty', 'error'] as const)(
    'starts on the provider default and keeps the saved picker when discovery is %s',
    async (listing) => {
      const { store, access, claude, events, adapter } = fixture(true, listing)
      try {
        await adapter.acquire({
          identity: identityFor(),
          fence: 7,
          spawnToken: 'spawn-9',
          events: recordingJournalSink()
        })
        await claudeStartupSettled(adapter, 'session-1')
        expect(events.some((event) => event.type === 'started')).toBe(true)
        expect(claude.connections[0].launch.options.model).toBeUndefined()
        const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
        expect(options.models).toContainEqual(
          expect.objectContaining({ id: SAVED_MODEL.id, label: SAVED_MODEL.label })
        )
        expect(options.models[0]).not.toHaveProperty('defaultEffort')
        expect(options.models[0]).not.toHaveProperty('supportsFastMode')
        expect(store.get(access.fingerprint)?.models).toEqual([SAVED_MODEL])
        // Saved picker metadata cannot refuse a choice while live discovery is unavailable.
        await expect(
          adapter.setOption({ sessionId: 'session-1', key: 'fastMode', value: 'true', fence: 7 })
        ).resolves.toMatchObject({ fastMode: 'true' })
        await expect(
          adapter.dispatch({
            sessionId: 'session-1',
            clientMessageId: 'client-1',
            body: USER_MESSAGE,
            fence: 7
          })
        ).resolves.toEqual({ state: 'admitted' })
        expect(claude.connections[0].sent).toContainEqual(expect.objectContaining({ type: 'user' }))
        expect(events.some((event) => event.type === 'ended')).toBe(false)
      } finally {
        await adapter.closeAll()
      }
    }
  )

  it.each(['empty', 'failed-start'] as const)(
    'a new connection recovers after %s despite the host probe backoff',
    async (firstResult) => {
      let available = false
      const children: ReturnType<typeof fakeClaude>[] = []
      const openConnection: typeof openClaudeStreamJsonConnection = async (launch, handlers) => {
        const models = available ? [{ value: 'recovered', displayName: 'Recovered' }] : []
        const child = fakeClaude({
          initModels: models,
          settings: {},
          ...(!available && firstResult === 'failed-start'
            ? { exitBeforeInit: 'initialize rejected' }
            : {})
        })
        children.push(child)
        const connection = await child.openConnection(launch, handlers)
        // Like the SDK, each connection reads only its own initialize snapshot.
        connection.supportedModels = async () => models
        return connection
      }
      const { adapter, access, store } = fixture(false, 'empty', openConnection)
      try {
        await store.refresh(access.fingerprint, 'claude', access, async () => {
          throw new Error('host probe failed')
        })
        expect(store.shouldRefresh(access.fingerprint)).toBe(false)
        const acquire = adapter.acquire({
          identity: identityFor(),
          fence: 7,
          spawnToken: 'spawn-9'
        })
        if (firstResult === 'failed-start') {
          await expect(acquire).rejects.toThrow('initialize rejected')
        } else {
          await acquire
          await claudeStartupSettled(adapter, 'session-1')
        }
        available = true
        if (firstResult === 'empty') {
          const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
          expect(options.models.some((model) => model.id === 'recovered')).toBe(false)
          expect(store.get(access.fingerprint)).toBeNull()
        } else {
          await adapter.drainObservedExits()
          expect(children[0].connections[0].closed).toBe(true)
        }
        await adapter.closeSession('session-1')
        expect(store.hasActiveFailure(access.fingerprint)).toBe(true)
        await adapter.acquire({ identity: identityFor(), fence: 8, spawnToken: 'spawn-10' })
        await claudeStartupSettled(adapter, 'session-1')
        const options = await adapter.readOptions({ sessionId: 'session-1', fence: 8 })
        expect(options.models).toContainEqual({
          id: 'recovered',
          label: 'Recovered',
          isDefault: false,
          efforts: []
        })
        expect(children).toHaveLength(2)
        expect(children[1].connections[0].launch.options.model).toBeUndefined()
        expect(store.get(access.fingerprint)?.models[0].id).toBe('recovered')
        expect(store.hasActiveFailure(access.fingerprint)).toBe(false)
      } finally {
        await adapter.closeAll()
      }
    }
  )
})
