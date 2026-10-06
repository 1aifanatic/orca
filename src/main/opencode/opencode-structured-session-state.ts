import type {
  AgentSessionJournalIdentity,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import type {
  AgentSessionOptionsResult,
  AgentSessionModelOption,
  AgentSessionSlashCommand
} from '../../shared/agent-session-wire'
import type { StructuredAgentSessionEndedEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { ProviderTimelineLane } from '../native-chat/agent-session-timeline/provider-timeline-lane'
import type { OpenCodeServerConnection, openOpenCodeServer } from './serve/server-connection'
import type { OpenCodeSessionClient } from './serve/session-client'
import type { StructuredAgentSessionTaskQueue } from '../native-chat/agent-session-wire/structured-agent-session-task-queue'
import type { readOpenCodeTranscriptPageViaWorker } from '../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import type {
  OpenCodeNativeSession,
  OpenCodePermissionRule,
  OpenCodeWireEvent
} from './serve/native-protocol'
import type {
  OpenCodeTimelineTranslator,
  OpenCodePendingRequest
} from './serve/timeline-translator'

export type OpenCodeStructuredLaunch = {
  command: string
  cwd: string
  environment: Record<string, string>
  resumeSessionId: string | null
  permissions: readonly OpenCodePermissionRule[]
  agent: 'opencode' | 'opencode2'
  options?: Readonly<Record<string, string>>
}

export type OpenCodeStructuredSessionAdapterDeps = {
  resolveLaunch: (input: {
    identity: AgentSessionJournalIdentity
  }) => Promise<OpenCodeStructuredLaunch>
  openServer?: typeof openOpenCodeServer
  readHistoryPage?: typeof readOpenCodeTranscriptPageViaWorker
  onEvent?: (event: StructuredAgentSessionEndedEvent) => void
  onChildWorkEvidence?: (sessionId: string, evidence: AgentChildWorkEvidence[]) => void
  onDispatchSettledLate?: (input: {
    sessionId: string
    clientMessageId: string
    providerIdentity: AgentJournalItemIdentity
  }) => void
  onPrimaryThreadStoppedRunning?: (input: { sessionId: string }) => void
  onCatalog?: (sessionId: string, models: readonly AgentSessionModelOption[]) => void
  logger?: StructuredAgentSessionLogger
  readProcessStartTime?: (pid: number) => Promise<number | null>
  now?: () => number
  mintLinkId?: () => string
  mintAcquisitionGeneration?: () => string
}

export type OpenCodeSession = {
  sessionId: string
  fence: number
  generation: string
  launch: OpenCodeStructuredLaunch
  connection: OpenCodeServerConnection
  process: AgentSessionProcessIdentity | null
  client: OpenCodeSessionClient | null
  root: OpenCodeNativeSession | null
  translator: OpenCodeTimelineTranslator | null
  lane: ProviderTimelineLane | null
  streamAbort: AbortController
  ready: boolean
  ended: boolean
  closing: 'requested-close' | 'unexpected-exit' | null
  exitObservedAt: number | null
  pending: Map<string, OpenCodePendingRequest>
  claims: Set<string>
  outstanding: Map<string, string | null>
  dispatchOrder: { clientMessageId: string; requestedAt: number }[]
  inputRecorded: Set<string>
  optionValues: Record<string, string>
  restoreSkippedOptions: string[]
  options: AgentSessionOptionsResult['current']
  commands: AgentSessionSlashCommand[]
  models: AgentSessionModelOption[]
  modes: NonNullable<AgentSessionOptionsResult['modes']>
  heldFrames: OpenCodeWireEvent[]
  heldFrameBytes: number
  eventQueue: StructuredAgentSessionTaskQueue
  childActive: Set<string>
}
