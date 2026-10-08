import { describe, expect, it } from 'vitest'
import { CLAUDE_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionPicks,
  structuredAgentSessionOptionSnapshot
} from '../../shared/structured-agent-session-options'
import {
  applyNativeChatSessionOptionPicks,
  resolveStructuredLaunchSeedOptions
} from '../../shared/native-chat-session-option-defaults'
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
  id: 'retired-account-default',
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
    ...(saved ? { settings: {} } : {}),
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

describe('Claude unknown current model persistence', () => {
  it.each(['empty', 'error'] as const)(
    'keeps an effort-only choice off future model flags after an %s listing',
    async (listing) => {
      const { adapter } = fixture(true, listing)
      try {
        await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
        await claudeStartupSettled(adapter, 'session-1')
        const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
        const state = applyStructuredAgentSessionOptions(
          createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG),
          CLAUDE_SESSION_OPTION_CATALOG,
          result
        )
        expect(result.current.model).toBe('')
        const [model] = structuredAgentSessionOptionSnapshot(state)
        expect(model).toMatchObject({ valueSource: 'unknown' })
        expect(model.kind).not.toHaveProperty('currentValue')
        expect(state.catalog?.models.map((row) => row.id)).toEqual([SAVED_MODEL.id])
        const committed = await adapter.setOption({
          sessionId: 'session-1',
          key: 'effort',
          value: 'high',
          fence: 7
        })
        expect(committed).toEqual({ effort: 'high' })
        const picks = structuredAgentSessionOptionPicks(state, committed ?? {})
        const persisted = applyNativeChatSessionOptionPicks({
          persisted: null,
          agent: 'claude',
          picks
        })
        const launch = resolveStructuredLaunchSeedOptions(persisted, 'claude')
        expect(picks).toEqual([])
        expect(launch?.model).toBeUndefined()
        const selection = await adapter.setOption({
          sessionId: 'session-1',
          key: 'model',
          value: SAVED_MODEL.id,
          fence: 7
        })
        const selected = applyNativeChatSessionOptionPicks({
          persisted,
          agent: 'claude',
          picks: structuredAgentSessionOptionPicks(state, selection ?? {})
        })
        expect(resolveStructuredLaunchSeedOptions(selected, 'claude')?.model).toBe(SAVED_MODEL.id)
      } finally {
        await adapter.closeAll()
      }
    }
  )
})
