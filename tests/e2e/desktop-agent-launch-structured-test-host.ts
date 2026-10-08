import { join } from 'node:path'
import { vi } from 'vitest'
import { claudeProviderHandle } from '../../src/shared/agent-session-provider-handle-encoding'
import type { AgentSessionMutationEnvelope } from '../../src/shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../src/main/runtime/agent-session-record-store'
import type { AgentLaunchRuntimeStub } from '../../src/main/runtime/rpc/methods/agent-launch.test-fixture'
import { StructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { NO_STRUCTURED_AGENTS } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import { openTestJournalHostDatabase } from '../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { recordingStructuredAgentSessionLogger } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-logger-test-support'

export function installDesktopStructuredTestHost(
  runtime: AgentLaunchRuntimeStub,
  record: AgentSessionRecordStore,
  directory: string
) {
  const acquire = vi.fn(async (input: { fence: number; spawnToken: string }) => ({
    process: {
      hostId: 'local',
      pid: 4000,
      processStartTimeMs: Date.now(),
      spawnToken: input.spawnToken
    },
    link: {
      linkId: 'composed-link',
      mintedAtFence: input.fence,
      observedAt: Date.now(),
      origin: 'created' as const,
      handle: claudeProviderHandle('00000000-0000-4000-8000-000000000001', null)
    }
  }))
  const host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    store: record,
    journalDatabase: openTestJournalHostDatabase(directory),
    logger: recordingStructuredAgentSessionLogger().logger,
    claimKeyId: 'composed-key',
    adapter: {
      supportsLocation: () => true,
      acquire,
      dispatch: async () => ({ state: 'admitted' }),
      cancelTurn: async () => ({ cancelled: true }),
      answerPrompt: async () => {},
      setOption: async () => {},
      releaseAcquisition: async () => true,
      closeSession: async () => true,
      readOptions: async () => ({ models: [], current: {} })
    }
  })
  setStructuredAgentSessionHost(host)
  const visible = new Set<string>()
  const resolve = vi.fn(async (input: { envelope: AgentSessionMutationEnvelope }) => ({
    envelope: input.envelope,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'wt-7',
      workspaceKind: 'git-worktree' as const
    },
    agent: 'claude' as const,
    provider: 'claude' as const,
    accountHome: { variable: 'CLAUDE_CONFIG_DIR' as const, path: join(directory, 'account') },
    runtimeKind: 'native' as const
  }))
  const publish = vi.fn(async (input: { sessionId: string; tabId?: string }) => {
    await host.setSessionTabVisibility(input.sessionId, true, input.tabId)
    visible.add(input.sessionId)
  })
  const retire = vi.fn((sessionId: string) => visible.delete(sessionId))
  Object.assign(runtime, {
    resolveStructuredAgentSessionCreateIntent: resolve,
    publishStructuredAgentSessionTab: publish,
    retireStructuredAgentSessionTabFromSnapshot: retire
  })
  return {
    host,
    resolve,
    publish,
    retire,
    visible,
    acquire,
    attachOriginal: host.attach.bind(host),
    sendOriginal: host.send.bind(host),
    attach: vi.spyOn(host, 'attach'),
    send: vi.spyOn(host, 'send'),
    close: vi.spyOn(host, 'close')
  }
}
