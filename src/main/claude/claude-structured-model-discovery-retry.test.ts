import { describe, expect, it } from 'vitest'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { claudeAcquireCatalogAccess } from './claude-structured-acquire-catalog'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
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

function fixture(saved: boolean, listing: 'empty' | 'error') {
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
    openConnection: claude.openConnection,
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
        expect(options.models).toContainEqual(SAVED_MODEL)
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

  it('recovers the picker from a later successful live listing without restarting', async () => {
    const { claude, adapter, access, store } = fixture(false, 'error')
    try {
      await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
      await claudeStartupSettled(adapter, 'session-1')
      expect(
        (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).models.length
      ).toBeGreaterThan(0)
      expect(store.get(access.fingerprint)).toBeNull()
      claude.routes.list_models = () => [{ value: 'recovered', displayName: 'Recovered' }]
      expect((await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).models).toEqual([
        { id: 'recovered', label: 'Recovered', isDefault: false, efforts: [] },
        expect.objectContaining({ id: 'claude-sonnet-5' })
      ])
      expect(store.get(access.fingerprint)?.models[0].id).toBe('recovered')
    } finally {
      await adapter.closeAll()
    }
  })
})
