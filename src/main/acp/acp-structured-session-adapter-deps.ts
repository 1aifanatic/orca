import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type { AgentJournalDispatchRejection } from '../../shared/agent-session-failure-words'
import type { AcpLaunchSpec } from './acp-launch-specs'
import type { SpawnAcpStructuredChild } from './acp-structured-child'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'

/** How long a Stop waits for the agent to end its turn before the child is closed. */
export const ACP_CANCEL_TIMEOUT_MS = 10_000

export type AcpStructuredSessionAdapterDeps = {
  spec: AcpLaunchSpec
  resolveLaunch: (input: { identity: AgentSessionJournalIdentity }) => Promise<AcpStructuredLaunch>
  spawnChild: SpawnAcpStructuredChild
  readProcessStartTime?: (pid: number) => Promise<number | null>
  /** Every exit, expected or not: the host ends that child's record. */
  onEvent?: (event: StructuredAgentSessionLifecycleEvent) => void
  /** A send this adapter admitted, settled once the agent answered for it. */
  onDispatchSettledLate?: (
    settlement: { sessionId: string; clientMessageId: string } & (
      | { providerIdentity: AgentJournalItemIdentity }
      | ({ state: 'rejected' } & AgentJournalDispatchRejection)
      | { state: 'unknown'; reason: string }
    )
  ) => void
  logger?: StructuredAgentSessionLogger
  now?: () => number
  mintGeneration?: () => string
  mintLinkId?: () => string
  /** Bounds a Stop's wait for the agent to end its turn; past it the child is closed. */
  cancelTimeoutMs?: number
  /** Bounds the handshake and session load or creation; past it the start fails. */
  startupTimeoutMs?: number
  isWindowsProcessStartTimeAvailable?: () => boolean
}
