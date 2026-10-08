import { describe, expect, it } from 'vitest'
import { CLAUDE_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  canSetStructuredAgentSessionOption
} from '../../shared/structured-agent-session-options'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { claudeAcquireCatalogAccess } from './claude-structured-acquire-catalog'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  claudeStartupSettled,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

const ACCOUNT_HOME = '/accounts/claude'
const SAVED_MODEL = {
  id: 'sonnet',
  label: 'Account model',
  isDefault: true,
  efforts: [
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' }
  ],
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

describe('Claude cached model capabilities', () => {
  it.each(['empty', 'error'] as const)(
    'keeps xhigh usable after an %s listing without reusing saved defaults',
    async (listing) => {
      const { adapter } = fixture(true, listing)
      try {
        await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
        await claudeStartupSettled(adapter, 'session-1')
        const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
        expect(result.models[0]).toMatchObject({ id: SAVED_MODEL.id, label: SAVED_MODEL.label })
        expect(result.models[0]).not.toHaveProperty('defaultEffort')
        expect(result.models[0]).not.toHaveProperty('supportsFastMode')
        const state = applyStructuredAgentSessionOptions(
          createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG),
          CLAUDE_SESSION_OPTION_CATALOG,
          result
        )
        await expect(
          adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'xhigh', fence: 7 })
        ).resolves.toMatchObject({ effort: 'xhigh' })
        expect(canSetStructuredAgentSessionOption(state, 'effort', 'xhigh')).toBe(true)
      } finally {
        await adapter.closeAll()
      }
    }
  )
})
