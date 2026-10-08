import { useEffect, type MutableRefObject } from 'react'
import type { AgentSessionModelCatalogResult } from '../../../src/shared/agent-session-wire'
import type { AgentSessionOptionCatalog } from '../../../src/shared/agent-session-option-catalog'
import type { NativeChatSessionOptionRecord } from '../../../src/shared/native-chat-session-option-state'
import {
  applyStructuredAgentSessionModelCatalog,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'
import type { RpcClient } from '../transport/rpc-client'
import { callAgentSession } from './mobile-structured-agent-session-rpc'

// The host answers a waiting read when its first listing lands, within its own 30s picker wait.
const LISTING_WAIT_TIMEOUT_MS = 45_000

/**
 * The desktop's host-catalog upgrade on the phone: the picker lists the account's models from the
 * host store while the session's own options read may still wait on its attach. An older host
 * refuses the method, and the seed stands until the options read lands.
 */
export function useMobileHostModelCatalogUpgrade(args: {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  /** This phone created the chat, so it launches the listed default; a reopened one may not. */
  newLaunch: boolean
  /** Where a new chat runs: the host names no default its config could replace. */
  worktree?: string
  fence: number | null
  optionCatalog: AgentSessionOptionCatalog | null
  activeOptionRecordRef: MutableRefObject<NativeChatSessionOptionRecord>
  optionMutationGeneration: MutableRefObject<number>
  updateOptionState: (
    update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
  ) => void
}): void {
  const {
    activeOptionRecordRef,
    agent,
    client,
    enabled,
    fence,
    newLaunch,
    optionCatalog,
    optionMutationGeneration,
    sessionId,
    updateOptionState,
    worktree
  } = args
  useEffect(() => {
    if (!client || !sessionId || !enabled || !agent || !optionCatalog) {
      return
    }
    let stale = false
    const readGeneration = optionMutationGeneration.current
    const params = { agent, sessionId, ...(newLaunch && worktree ? { worktree } : {}) }
    const read = (waitForListing: boolean): Promise<AgentSessionModelCatalogResult> =>
      waitForListing
        ? callAgentSession(
            client,
            'agentSession.modelCatalog',
            { ...params, waitForListing },
            LISTING_WAIT_TIMEOUT_MS
          )
        : callAgentSession(client, 'agentSession.modelCatalog', params)
    const apply = (catalog: AgentSessionModelCatalogResult): void => {
      if (stale || optionMutationGeneration.current !== readGeneration) {
        return
      }
      updateOptionState((current) =>
        current.record === activeOptionRecordRef.current
          ? applyStructuredAgentSessionModelCatalog(current, optionCatalog, catalog, { newLaunch })
          : current
      )
    }
    void read(false)
      .then((catalog) =>
        catalog.origin === 'unknown' && catalog.listingInProgress === true && !stale
          ? read(true).then(apply)
          : apply(catalog)
      )
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [
    activeOptionRecordRef,
    agent,
    client,
    enabled,
    fence,
    newLaunch,
    optionCatalog,
    optionMutationGeneration,
    sessionId,
    updateOptionState,
    worktree
  ])
}
