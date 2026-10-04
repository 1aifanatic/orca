import { useEffect, type MutableRefObject } from 'react'
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
 * After `unknown` — the host has no listing for the account yet and started one in the background,
 * which it announces nowhere — re-read on this schedule until it lands. It spans the host's listing
 * timeout, then stops: a host that never lists leaves the seed to the live read.
 */
export const HOST_MODEL_CATALOG_REREAD_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 15_000, 30_000
]

/** Reads until the host answers with a listing or the schedule runs out; the result stops it. */
function readHostModelCatalogUntilListed(args: {
  read: () => Promise<AgentSessionModelCatalogResult>
  apply: (catalog: AgentSessionModelCatalogResult) => void
  wantsReread: () => boolean
}): () => void {
  let stopped = false
  let reread: ReturnType<typeof setTimeout> | null = null
  const attempt = (index: number): void => {
    void args
      .read()
      .then((catalog) => {
        if (stopped) {
          return
        }
        args.apply(catalog)
        const delay = HOST_MODEL_CATALOG_REREAD_DELAYS_MS[index]
        if (catalog.origin !== 'unknown' || delay === undefined) {
          return
        }
        reread = setTimeout(() => {
          reread = null
          if (args.wantsReread()) {
            attempt(index + 1)
          }
        }, delay)
      })
      .catch(() => {})
  }
  attempt(0)
  return () => {
    stopped = true
    if (reread) {
      clearTimeout(reread)
    }
  }
}

/**
 * Upgrades the static seed with the host's stored catalog without waiting on
 * attach. A record-less read (no session yet) resolves the account a launch
 * would pin, so the picker warms during create. An older host answers
 * `forbidden` or `method_not_found` — both mean "no such surface", so the seed
 * stands until the live read lands.
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
  optionStateRef: { readonly current: StructuredAgentSessionOptionState }
  activeOptionRecordRef: MutableRefObject<NativeChatSessionOptionRecord>
  updateOptionState: (
    update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
  ) => void
}): void {
  const {
    activeOptionRecordRef,
    agent,
    enabled,
    fence,
    namesDefault,
    optionCatalog,
    optionStateRef,
    sessionId,
    target,
    updateOptionState,
    worktree
  } = args
  useEffect(() => {
    if (!enabled || !optionCatalog || (agent !== 'claude' && agent !== 'codex')) {
      return
    }
    return readHostModelCatalogUntilListed({
      read: () =>
        callStructuredAgentSession<AgentSessionModelCatalogResult>(
          target,
          'agentSession.modelCatalog',
          { agent, sessionId, ...(namesDefault && worktree ? { worktree } : {}) }
        ),
      apply: (catalog) =>
        updateOptionState((current) =>
          current.record === activeOptionRecordRef.current
            ? applyStructuredAgentSessionModelCatalog(current, optionCatalog, catalog, {
                namesDefault
              })
            : current
        ),
      // The running provider's own list already outranks anything the store could add.
      wantsReread: () => optionStateRef.current.catalogSource !== 'live'
    })
  }, [
    activeOptionRecordRef,
    agent,
    enabled,
    fence,
    namesDefault,
    optionCatalog,
    optionStateRef,
    sessionId,
    target,
    updateOptionState,
    worktree
  ])
}
