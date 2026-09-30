import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { buildRuntimeMobileAgentStatus } from './runtime-mobile-agent-status-builder'

const processIdentity = { pid: 4001, platform: 'linux', startTime: 'boot:123' } as const

function projectOwner(ended: boolean) {
  const now = Date.now()
  const row: AgentStatusIpcPayload = {
    paneKey: 'tab:leaf',
    tabId: 'tab',
    worktreeId: 'folder-1',
    connectionId: null,
    state: 'done',
    prompt: '',
    receivedAt: now,
    stateStartedAt: now,
    agentType: 'claude',
    agentPresence: {
      agent: 'claude',
      process: processIdentity,
      ...(ended ? { ended: true } : {})
    },
    ...(ended ? { providerSessionOnly: true } : {})
  }
  return buildRuntimeMobileAgentStatus(
    null,
    {
      type: 'terminal',
      id: 'tab::leaf',
      parentTabId: 'tab',
      leafId: 'leaf',
      title: 'zsh',
      launchAgent: 'claude',
      isActive: true
    },
    null,
    null,
    () => [row],
    {
      getPaneKey: () => row.paneKey,
      getLeaf: () => null,
      getTrackedTitle: () => null
    }
  )
}

describe('headless mobile owner projection', () => {
  it('preserves an idle host owner without a renderer or an agent title', () => {
    expect(projectOwner(false)).toMatchObject({
      agentStatus: {
        agentPresence: { agent: 'claude', process: processIdentity }
      }
    })
  })

  it('carries a positive exit through the snapshot even with a stale launch hint', () => {
    expect(projectOwner(true)).toMatchObject({
      agentStatus: {
        agentPresence: { agent: 'claude', process: processIdentity, ended: true }
      }
    })
  })
})

import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import { projectSessionTabsForClient } from './rpc/methods/session-tabs-inventory'
import { AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { makePaneKey } from '../../shared/stable-pane-id'

it('negotiates the full snapshot and never accepts client-published presence as host evidence', () => {
  const leafId = '11111111-1111-4111-8111-111111111111'
  const paneKey = makePaneKey('tab', leafId)
  const row: AgentStatusIpcPayload = {
    paneKey,
    tabId: 'tab',
    worktreeId: 'folder',
    connectionId: null,
    state: 'done',
    prompt: '',
    receivedAt: 10,
    stateStartedAt: 5,
    providerSessionOnly: true,
    agentType: 'claude',
    agentPresence: { agent: 'claude', process: processIdentity, ended: true }
  }
  const spoofedAuthority = { agentPresenceFromExecutionHost: true }
  const snapshot: RuntimeMobileSessionTabsSnapshot = {
    worktree: 'folder',
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: 'tab',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab::leaf',
        parentTabId: 'tab',
        leafId,
        title: 'zsh',
        isActive: true,
        launchAgent: 'claude',
        agentStatus: {
          state: 'done',
          prompt: '',
          paneKey,
          updatedAt: 99999,
          stateStartedAt: 99999,
          stateHistory: [],
          agentType: 'claude',
          agentPresence: {
            agent: 'claude',
            process: processIdentity,
            observation: { epoch: 'client', sequence: 999 }
          },
          ...spoofedAuthority
        }
      }
    ]
  }
  let rows = [row]
  const host: RuntimeMobileSessionProjectionHost = {
    tabs: new Map(),
    leaves: new Map(),
    ptysById: new Map(),
    getLiveBrowserTabs: () => new Map(),
    getProviderSessionRows: () => rows,
    getProviderSessionSnapshot: () => rows,
    getStatusSnapshot: () => [],
    getLeafKey: () => '',
    findPty: () => null,
    getRetainedStatus: () => null,
    getTrackedTitle: () => null,
    issuePtyHandle: () => 'terminal',
    recordPty: () => {
      throw new Error('unexpected pty')
    },
    buildPtyStatus: () => ({}),
    sanitizeGroups: () => undefined,
    pruneGroupLayout: () => null,
    collectTabIds: () => new Set()
  }
  const result = projectRuntimeMobileSessionTabs(snapshot, host)
  const capable = [AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY]
  expect(projectSessionTabsForClient(result, 'mobile', capable, false).tabs[0]).toMatchObject({
    agentStatus: { agentPresence: row.agentPresence, updatedAt: 10, stateStartedAt: 5 }
  })
  expect(projectSessionTabsForClient(result, 'mobile', [], false).tabs[0]).not.toHaveProperty(
    'agentStatus.agentPresence'
  )
  rows = []
  expect(
    projectSessionTabsForClient(
      projectRuntimeMobileSessionTabs(snapshot, host),
      'mobile',
      capable,
      false
    ).tabs[0]
  ).not.toHaveProperty('agentStatus.agentPresence')
})
