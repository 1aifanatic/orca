// Opening the agent a chat message is from: its chat through the open-chat flow, or its terminal
// through the terminal-handle link's path. Feedback is chosen by what the host found, never by how
// the sender was addressed, and uses words that already exist.

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import { AGENT_SESSION_WRITE_NOTICE_COPY } from '../../../shared/agent-session-write-notice-copy'
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
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
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

type Sender = AgentMessageSource['senders'][number]
type Lookup = OrchestrationPartyLocationResult | 'unsupported' | 'unreachable'

/** The answers that prove the terminal is gone; anything else proves nothing about it. */
const TERMINAL_GONE_CODES = new Set([
  'terminal_exited',
  'terminal_gone',
  'terminal_handle_stale',
  'terminal_not_found'
])

const opensInFlight = new Map<string, Promise<void>>()

/** `chatWorktreeId`: the chat showing the message. The sender lives on that chat's host, so every
 *  call goes to that host. */
export function openAgentMessageSender(
  source: AgentMessageSource,
  sender: Sender,
  chatWorktreeId: string
): Promise<void> {
  const key = `${chatWorktreeId}\0${sender.party.address}`
  const inFlight = opensInFlight.get(key)
  if (inFlight) {
    return inFlight
  }
  const opening = openSender(source, sender, chatWorktreeId).finally(() =>
    opensInFlight.delete(key)
  )
  opensInFlight.set(key, opening)
  return opening
}

async function openSender(
  source: AgentMessageSource,
  { party }: Sender,
  chatWorktreeId: string
): Promise<void> {
  const environmentId = getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), chatWorktreeId)
  // The mail it carried from this sender, whose pane outlives a handle from an earlier run.
  const messageIds = (source.orchestration?.messages ?? [])
    .filter((message) => message.from === party.address)
    .map((message) => message.messageId)
  const found = await lookUpSender(
    party,
    messageIds,
    getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId })
  )
  if (found === 'unsupported' || found === 'unreachable') {
    showLookupFailure(found)
    return
  }
  const { location } = found
  if (!location) {
    if (found.lost === 'chat') {
      structuredSessionOpenFeedback.gone()
    } else {
      showAgentPaneUnavailable()
    }
    return
  }
  if (location.kind === 'chat') {
    await activateAiVaultStructuredSession({
      structuredSession: { workspaceId: location.worktreeId, sessionId: location.sessionId }
    })
    return
  }
  if (location.kind !== 'terminal') {
    // A kind a newer host answers with.
    showLookupFailure('unsupported')
    return
  }
  await focusTerminal(location.handle, environmentId)
}

async function focusTerminal(handle: string, environmentId: string | null): Promise<void> {
  if (focusRendererTerminalHandle(handle, environmentId)) {
    return
  }
  try {
    await focusRuntimeTerminalHandle(handle, environmentId)
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && TERMINAL_GONE_CODES.has(error.code)) {
      showAgentPaneUnavailable()
    } else {
      showLookupFailure(isRuntimeCompatBlockError(error) ? 'unsupported' : 'unreachable')
    }
  }
}

async function lookUpSender(
  party: Sender['party'],
  messageIds: readonly string[],
  host: RuntimeClientTarget
): Promise<Lookup> {
  try {
    return await callRuntimeRpc<OrchestrationPartyLocationResult>(
      host,
      'orchestration.partyLocation',
      { address: party.address, ...(messageIds.length > 0 ? { messageIds } : {}) }
    )
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return lookUpOnOlderHost(party)
    }
    return isRuntimeCompatBlockError(error) ? 'unsupported' : 'unreachable'
  }
}

/** A host before the lookup: a chat open here under its root id, as one never `/clear`ed is, or a
 *  terminal by its handle; anything else needs that host updated. */
function lookUpOnOlderHost(party: Sender['party']): Lookup {
  const sessionId = party.orcaSessionId
  if (sessionId) {
    const tabsByWorktree = useAppStore.getState().unifiedTabsByWorktree
    for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
      if (tabs.some((tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId)) {
        return located({ kind: 'chat', sessionId, worktreeId })
      }
    }
    return 'unsupported'
  }
  const handle = party.terminalHandle
  return handle && !handle.startsWith('dispatch:') && !handle.startsWith('run:')
    ? located({ kind: 'terminal', handle })
    : 'unsupported'
}

function located(location: OrchestrationPartyLocation): OrchestrationPartyLocationResult {
  return { location }
}

/** Words for a sender of any kind: the host could not answer, or must be updated first. */
function showLookupFailure(failure: 'unsupported' | 'unreachable'): void {
  toast.error(
    failure === 'unsupported'
      ? translate(
          'components.native-chat.writeNotice.unsupported',
          AGENT_SESSION_WRITE_NOTICE_COPY.unsupported
        )
      : translate(
          'components.native-chat.writeNotice.unreachable',
          AGENT_SESSION_WRITE_NOTICE_COPY.unreachable
        )
  )
}
