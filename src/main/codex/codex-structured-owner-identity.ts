import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import {
  agentSessionProviderHandleKey,
  type AgentSessionProviderHandleLink
} from '../../shared/agent-session-provider-handle'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import {
  STRUCTURED_PROVIDER_SPAWN_TOKEN_ENV,
  structuredProviderProcessIdentity
} from '../provider-process/structured-process-identity'

// What the lease records about the child Codex just handed back: the process it
// will later re-prove, and the provider handle link the journal binds to. Both
// must describe the thread Codex actually opened, never the one a client asked
// for.

/** The child echoes its spawn token here so the owner probe can tell a live
 *  child of THIS reservation from a same-pid stranger. */
export const CODEX_SPAWN_TOKEN_ENV = STRUCTURED_PROVIDER_SPAWN_TOKEN_ENV

/**
 * The child's identity, read once. The real connection reports its spawn before the handshake, and
 * `onSpawned` makes it durable there, so a crash mid-start leaves an owner recovery can stop; a
 * connection that reports no spawn is identified once it is open.
 */
export function codexSpawnedProcessIdentity(
  input: {
    identity: AgentSessionJournalIdentity
    spawnToken: string
    onSpawned?: (process: AgentSessionProcessIdentity) => Promise<void>
  },
  readStartTime?: (pid: number) => Promise<number | null>
): {
  onSpawned: (pid: number) => Promise<void>
  read: (pid: number | undefined) => Promise<AgentSessionProcessIdentity>
} {
  let spawned: Promise<AgentSessionProcessIdentity> | undefined
  return {
    onSpawned: async (pid) => {
      spawned = codexProcessIdentity({ ...input, pid }, readStartTime)
      await input.onSpawned?.(await spawned)
    },
    read: (pid) => spawned ?? codexProcessIdentity({ ...input, pid }, readStartTime)
  }
}

export async function codexProcessIdentity(
  input: {
    identity: AgentSessionJournalIdentity
    spawnToken: string
    pid: number | undefined
  },
  readStartTime?: (pid: number) => Promise<number | null>
): Promise<AgentSessionProcessIdentity> {
  return structuredProviderProcessIdentity(
    { ...input, processName: 'codex app-server' },
    readStartTime
  )
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
