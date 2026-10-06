// Opening the agent a chat message is from: its chat through the open-chat flow, or its terminal
// through the terminal-handle link's path, with the feedback those already give when they cannot.

import type { AgentMessageSender } from '../../../shared/agent-session-message-source'
import type {
  OrchestrationPartyLocation,
  OrchestrationPartyLocationResult
} from '../../../shared/orchestration-caller-status'
import { useAppStore } from '@/store'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  RuntimeRpcCallError,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import {
  focusRendererTerminalHandle,
  focusRuntimeTerminalHandle
} from '@/components/terminal-pane/terminal-handle-links'
import { showAgentPaneUnavailable } from '@/components/terminal-pane/stale-agent-row'
import {
  activateAiVaultStructuredSession,
  structuredSessionOpenFeedback
} from './activate-ai-vault-structured-session'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'

type Party = AgentMessageSender['party']

const opensInFlight = new Map<string, Promise<void>>()

/** `chatWorktreeId`: the chat showing the message. The sender lives on that chat's host, so every
 *  call goes to that host. */
export function openAgentMessageSender(party: Party, chatWorktreeId: string): Promise<void> {
  const key = `${chatWorktreeId}\0${party.address}`
  const inFlight = opensInFlight.get(key)
  if (inFlight) {
    return inFlight
  }
  const opening = openSender(party, chatWorktreeId).finally(() => opensInFlight.delete(key))
  opensInFlight.set(key, opening)
  return opening
}

async function openSender(party: Party, chatWorktreeId: string): Promise<void> {
  const environmentId = getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), chatWorktreeId)
  const located = await locateSender(
    party,
    getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId })
  )
  if (located === 'host-cannot-open') {
    structuredSessionOpenFeedback.hostCannotOpen()
    return
  }
  if (located === 'unreachable') {
    structuredSessionOpenFeedback.unavailable()
    return
  }
  if (located === null) {
    if (party.orcaSessionId) {
      structuredSessionOpenFeedback.gone()
    } else {
      showAgentPaneUnavailable()
    }
    return
  }
  if (located.kind === 'chat') {
    await activateAiVaultStructuredSession({
      structuredSession: { workspaceId: located.worktreeId, sessionId: located.sessionId }
    })
    return
  }
  if (focusRendererTerminalHandle(located.handle, environmentId)) {
    return
  }
  try {
    await focusRuntimeTerminalHandle(located.handle, environmentId)
  } catch {
    showAgentPaneUnavailable()
  }
}

async function locateSender(
  party: Party,
  host: RuntimeClientTarget
): Promise<OrchestrationPartyLocation | null | 'host-cannot-open' | 'unreachable'> {
  // A terminal is its own handle: no lookup, as the terminal-handle link resolves one.
  if (party.orcaSessionId === null && isPlainTerminalHandle(party.terminalHandle)) {
    return { kind: 'terminal', handle: party.terminalHandle }
  }
  try {
    const result = await callRuntimeRpc<OrchestrationPartyLocationResult>(
      host,
      'orchestration.partyLocation',
      { address: party.address }
    )
    return result.location
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return locateOnOlderHost(party)
    }
    return 'unreachable'
  }
}

function isPlainTerminalHandle(handle: string | null): handle is string {
  return handle !== null && !handle.startsWith('dispatch:') && !handle.startsWith('run:')
}

/** A host that predates the lookup: a chat open here under its root id, as a chat that was
 *  never `/clear`ed is; otherwise only an update can open it. */
function locateOnOlderHost(party: Party): OrchestrationPartyLocation | 'host-cannot-open' {
  const sessionId = party.orcaSessionId
  if (sessionId) {
    const tabsByWorktree = useAppStore.getState().unifiedTabsByWorktree
    for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
      if (tabs.some((tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId)) {
        return { kind: 'chat', sessionId, worktreeId }
      }
    }
    return 'host-cannot-open'
  }
  return isPlainTerminalHandle(party.terminalHandle)
    ? { kind: 'terminal', handle: party.terminalHandle }
    : 'host-cannot-open'
}
