import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import {
  agentSessionProviderHandleKey,
  type AgentSessionProviderHandleLink
} from '../../shared/agent-session-provider-handle'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import {
  PROVIDER_SPAWN_TOKEN_ENV,
  providerProcessIdentity,
  providerSpawnedProcessIdentity
} from '../provider-process/provider-spawned-process-identity'

// What the lease records about the child Codex just handed back: the process it
// will later re-prove, and the provider handle link the journal binds to. Both
// must describe the thread Codex actually opened, never the one a client asked
// for.

/** The child echoes its spawn token here so the owner probe can tell a live
 *  child of THIS reservation from a same-pid stranger. */
export const CODEX_SPAWN_TOKEN_ENV = PROVIDER_SPAWN_TOKEN_ENV

const CODEX_PROCESS_LABEL = 'codex app-server'

export function codexSpawnedProcessIdentity(
  input: {
    identity: AgentSessionJournalIdentity
    spawnToken: string
    onSpawned?: (process: AgentSessionProcessIdentity) => Promise<void>
  },
  readStartTime?: (pid: number) => Promise<number | null>
): ReturnType<typeof providerSpawnedProcessIdentity> {
  return providerSpawnedProcessIdentity(input, CODEX_PROCESS_LABEL, readStartTime)
}

export function codexProcessIdentity(
  input: {
    identity: AgentSessionJournalIdentity
    spawnToken: string
    pid: number | undefined
  },
  readStartTime?: (pid: number) => Promise<number | null>
): Promise<AgentSessionProcessIdentity> {
  return providerProcessIdentity(input, CODEX_PROCESS_LABEL, readStartTime)
}

type CodexProviderHandleLinkInput = {
  threadId: string
  fence: number
  linkId?: string
  observedAt: number
} & (
  | { origin?: 'adopted'; resumed: boolean; supersedesThreadId?: never }
  /** A new thread started in place of this unsaved one; only a creation can supersede. */
  | { origin?: never; resumed: false; supersedesThreadId: string }
)

export function codexProviderHandleLink(
  input: CodexProviderHandleLinkInput
): AgentSessionProviderHandleLink {
  return {
    linkId: input.linkId ?? `codex-${input.fence}-${input.threadId}`.slice(0, 128),
    handle: codexProviderHandle(input.threadId),
    origin: input.origin ?? (input.resumed ? 'resumed' : 'created'),
    mintedAtFence: input.fence,
    observedAt: input.observedAt,
    ...(input.supersedesThreadId
      ? {
          supersedesKey: agentSessionProviderHandleKey(
            codexProviderHandle(input.supersedesThreadId)
          )
        }
      : {})
  }
}
