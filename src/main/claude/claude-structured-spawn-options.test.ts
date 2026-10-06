import { describe, expect, it } from 'vitest'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import { agentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import {
  AgentModelCatalogStore,
  type AgentModelCatalogEntry
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  CLAUDE_STRUCTURED_BASE_OPTIONS,
  claudeStructuredPermissionOptions,
  type ClaudeStructuredSdkOptions
} from './claude-structured-launch-resolution'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import { claudeStructuredSpawnOptions } from './claude-structured-spawn-options'
import {
  claudeStartupSettled,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  recordingJournalSink
} from './claude-structured-session-test-support'

const ACCOUNT_HOME = '/accounts/claude'
const OPUS: AgentSessionModelOption = {
  id: 'opus',
  label: 'Opus',
  isDefault: true,
  efforts: [
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' }
  ],
  supportsFastMode: true
}
const HAIKU: AgentSessionModelOption = {
  id: 'haiku',
  label: 'Haiku',
  isDefault: false,
  efforts: [],
  supportsFastMode: false
}

function catalog(models: AgentSessionModelOption[]): AgentModelCatalogEntry {
  return {
    agent: 'claude',
    fingerprint: 'fingerprint',
    models,
    fastModeTierByModel: {},
    origin: 'probe',
    fetchedAt: 0
  }
}

function launched(
  saved: Record<string, string>,
  options: {
    catalog?: AgentModelCatalogEntry
    resumesTranscript?: boolean
    base?: ClaudeStructuredSdkOptions
  } = {}
) {
  const base = options.base ?? CLAUDE_STRUCTURED_BASE_OPTIONS
  return claudeStructuredSpawnOptions({
    launch: { options: base, resumesTranscript: options.resumesTranscript ?? true },
    saved,
    catalog: options.catalog ?? null
  })
}

const BYPASS_LAUNCH: ClaudeStructuredSdkOptions = {
  ...CLAUDE_STRUCTURED_BASE_OPTIONS,
  extraArgs: {
    ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs,
    ...claudeStructuredPermissionOptions('bypassPermissions').extraArgs
  }
}

describe('a Claude chat launched with its saved options', () => {
  it('passes the saved model, effort, Fast and permission mode as launch options', () => {
    const spawn = launched({
      model: 'opus',
      effort: 'high',
      fastMode: 'true',
      permissionMode: 'plan'
    })

    expect(spawn.sdkOptions).toMatchObject({
      model: 'opus',
      effort: 'high',
      settings: { fastMode: true },
      permissionMode: 'plan',
      // The base launch is kept whole.
      includePartialMessages: true,
      extraArgs: { 'replay-user-messages': null }
    })
    expect(Object.fromEntries(spawn.options)).toEqual({
      model: 'opus',
      effort: 'high',
      fastMode: 'true',
      permissionMode: 'plan'
    })
    expect(spawn.skipped).toEqual([])
  })

  it('passes everything unchecked when the account has no cached catalog', () => {
    const spawn = launched({ model: 'claude-retired-1', effort: 'low' })

    expect(spawn.sdkOptions).toMatchObject({ model: 'claude-retired-1', effort: 'low' })
    expect(spawn.skipped).toEqual([])
  })

  it('leaves out a saved model the cached catalog does not list, and records it skipped', () => {
    const spawn = launched({ model: 'claude-retired-1' }, { catalog: catalog([OPUS, HAIKU]) })

    expect(spawn.sdkOptions).not.toHaveProperty('model')
    expect(spawn.options.has('model')).toBe(false)
    expect(spawn.skipped).toEqual(['model'])
  })

  it('passes a saved model the cached catalog lists', () => {
    const spawn = launched({ model: 'haiku' }, { catalog: catalog([OPUS, HAIKU]) })

    expect(spawn.sdkOptions.model).toBe('haiku')
    expect(spawn.skipped).toEqual([])
  })

  it('leaves out an effort the cached entry for the saved model rules out', () => {
    const spawn = launched({ model: 'haiku', effort: 'high' }, { catalog: catalog([OPUS, HAIKU]) })

    expect(spawn.sdkOptions).toMatchObject({ model: 'haiku' })
    expect(spawn.sdkOptions).not.toHaveProperty('effort')
    expect(spawn.skipped).toEqual(['effort'])
  })

  it('passes an effort with no saved model, which the launch cannot check', () => {
    const spawn = launched({ effort: 'high' }, { catalog: catalog([HAIKU]) })

    expect(spawn.sdkOptions.effort).toBe('high')
  })

  it('leaves out an effort the CLI would refuse at launch', () => {
    expect(launched({ effort: 'ludicrous' }).skipped).toEqual(['effort'])
  })

  it('leaves out Fast the cached entry says the model does not support', () => {
    const spawn = launched({ model: 'haiku', fastMode: 'true' }, { catalog: catalog([HAIKU]) })

    expect(spawn.sdkOptions).not.toHaveProperty('settings')
    expect(spawn.skipped).toEqual(['fastMode'])
  })

  it('starts a new conversation with Fast off rather than carry a saved Fast on', () => {
    const spawn = launched({ fastMode: 'true' }, { resumesTranscript: false })

    expect(spawn.sdkOptions).not.toHaveProperty('settings')
    expect(spawn.options.has('fastMode')).toBe(false)
    // Left out by rule, not refused: nothing is recorded as skipped.
    expect(spawn.skipped).toEqual([])
  })

  it('passes a saved Fast off to a new conversation too', () => {
    const spawn = launched({ fastMode: 'false' }, { resumesTranscript: false })

    expect(spawn.sdkOptions.settings).toEqual({ fastMode: false })
  })

  it('launches a saved bypass under an Agent Permissions bypass with the owned bypass flag', () => {
    const spawn = launched({ permissionMode: 'bypassPermissions' }, { base: BYPASS_LAUNCH })

    expect(spawn.sdkOptions.extraArgs).toEqual({
      'replay-user-messages': null,
      'dangerously-skip-permissions': null
    })
    expect(spawn.sdkOptions).not.toHaveProperty('permissionMode')
    expect(spawn.sdkOptions).not.toHaveProperty('allowDangerouslySkipPermissions')
  })

  it('never widens the Agent Permissions setting to a saved bypass', () => {
    const spawn = launched({ permissionMode: 'bypassPermissions' })

    expect(spawn.sdkOptions.extraArgs).toEqual({ 'replay-user-messages': null })
    expect(spawn.skipped).toEqual(['permissionMode'])
  })

  it('replaces an Agent Permissions bypass with a saved narrower mode', () => {
    const spawn = launched({ permissionMode: 'acceptEdits' }, { base: BYPASS_LAUNCH })

    expect(spawn.sdkOptions.permissionMode).toBe('acceptEdits')
    expect(spawn.sdkOptions.extraArgs).toEqual({ 'replay-user-messages': null })
  })
})

describe('a Claude child launched against the account cached catalog', () => {
  async function startWith(
    options: Record<string, string>,
    cached: AgentSessionModelOption[] | null
  ) {
    const store = new AgentModelCatalogStore()
    const access = agentModelCatalogSessionAccess(store, 'claude', ACCOUNT_HOME)
    if (cached && access) {
      store.recordSuccess(access.fingerprint, 'claude', {
        models: cached,
        fastModeTierByModel: new Map(),
        origin: 'probe'
      })
    }
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = new ClaudeStructuredSessionAdapter({
      resolveLaunch: async () => ({
        pathToClaudeCodeExecutable: 'claude',
        options: {},
        cwd: '/work/repo',
        claudeConfigDir: ACCOUNT_HOME,
        providerSessionId: PROVIDER_SESSION_ID,
        resumeLeafUuid: null,
        resumesTranscript: true,
        continuesChain: true
      }),
      onEvent: (event) => events.push(event),
      openConnection: claude.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      now: () => 1_700_000_000_500,
      persistHandle: async () => {},
      modelCatalog: store
    })
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: recordingJournalSink(),
      options
    })
    await claudeStartupSettled(adapter, 'session-1')
    return { claude, events, adapter }
  }

  it('does not launch a saved model the cache does not list; the start drops it from the record', async () => {
    const { claude, events, adapter } = await startWith({ model: 'claude-retired-1' }, [OPUS])

    expect(claude.connections[0]!.launch.options).not.toHaveProperty('model')
    expect(adapter.readOptionRestoreFailures('session-1')).toEqual(['model'])
    expect(events.find((event) => event.type === 'started')).toMatchObject({
      restoreSkippedOptions: ['model']
    })
    // Nothing was asked of the CLI to find that out.
    expect(
      claude.connections[0]!.calls.filter((call) =>
        ['list_models', 'set_model', 'apply_flag_settings'].includes(call.subtype)
      )
    ).toEqual([])
  })

  it('launches the saved model unchecked when the account has never listed its models', async () => {
    const { claude, adapter } = await startWith({ model: 'claude-retired-1' }, null)

    expect(claude.connections[0]!.launch.options.model).toBe('claude-retired-1')
    expect(adapter.readOptionRestoreFailures('session-1')).toEqual([])
  })
})
