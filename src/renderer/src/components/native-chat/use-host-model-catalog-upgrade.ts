import { useEffect, useState, type MutableRefObject } from 'react'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { AgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { NativeChatSessionOptionRecord } from '../../../../shared/native-chat-session-option-state'

/**
 * Upgrades the static seed with the host's stored catalog without waiting on
 * attach. A record-less read (no session yet) resolves the account a launch
 * would pin, so the picker warms during create. An older host answers
 * `forbidden` or `method_not_found` — both mean "no such surface", so the seed
 * stands until the live read lands.
 *
 * When the host says its first listing for the account is running, one more
 * read waits for it. Returns true for exactly that wait.
 */
export function useHostModelCatalogUpgrade(args: {
  agent: AgentType
  sessionId: string
  target: RuntimeClientTarget
  optionCatalog: AgentSessionOptionCatalog | null
  /** The pane is on screen: a read can start a listing process, so hidden restored tabs must not. */
  enabled: boolean
  /** A launch runs the CLI default when nothing is seeded; a reopened session may not. */
  namesDefault: boolean
  /** Where the launch runs: the host names no default its config could replace. */
  worktree?: string
  fence: number | null
  activeOptionRecordRef: MutableRefObject<NativeChatSessionOptionRecord>
  updateOptionState: (
    update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
  ) => void
}): boolean {
  const {
    activeOptionRecordRef,
    agent,
    enabled,
    fence,
    namesDefault,
    optionCatalog,
    sessionId,
    target,
    updateOptionState,
    worktree
  } = args
  const [awaitingListing, setAwaitingListing] = useState(false)
  useEffect(() => {
    if (!enabled || !optionCatalog || (agent !== 'claude' && agent !== 'codex')) {
      return
    }
    let stale = false
    const params = { agent, sessionId, ...(namesDefault && worktree ? { worktree } : {}) }
    const read = (waitForListing: boolean): Promise<AgentSessionModelCatalogResult> =>
      callStructuredAgentSession<AgentSessionModelCatalogResult>(
        target,
        'agentSession.modelCatalog',
        waitForListing ? { ...params, waitForListing } : params
      )
    const apply = (catalog: AgentSessionModelCatalogResult): void =>
      updateOptionState((current) =>
        current.record === activeOptionRecordRef.current
          ? applyStructuredAgentSessionModelCatalog(current, optionCatalog, catalog, {
              namesDefault
            })
          : current
      )
    void read(false)
      .then(async (catalog) => {
        if (stale) {
          return
        }
        apply(catalog)
        // Only a host that reports the listing knows the wait param; an older one refuses it.
        if (catalog.origin !== 'unknown' || catalog.listingInProgress !== true) {
          return
        }
        setAwaitingListing(true)
        try {
          const listed = await read(true)
          if (!stale) {
            apply(listed)
          }
        } finally {
          if (!stale) {
            setAwaitingListing(false)
          }
        }
      })
      .catch(() => {})
    return () => {
      stale = true
      setAwaitingListing(false)
    }
  }, [
    activeOptionRecordRef,
    agent,
    enabled,
    fence,
    namesDefault,
    optionCatalog,
    sessionId,
    target,
    updateOptionState,
    worktree
  ])
  return awaitingListing
}
