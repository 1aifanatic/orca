import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import {
  clampConversationNameFirstPrompt,
  deriveConversationNamePlaceholder
} from '../../shared/conversation-name-generation'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from './agent-session-wire/structured-agent-session-logger'

export type StructuredChatNamingDeps = {
  getStore: () => Pick<
    AgentSessionRecordStore,
    'getRecord' | 'compareAndSetConversationName'
  > | null
  getSettings: () => Pick<GlobalSettings, 'nativeChatAutoName'>
  readFirstPrompt: (sessionId: string) => Promise<string>
  hasOpenDispatch: (record: AgentSessionRecord) => boolean
  generate: (record: AgentSessionRecord, firstPrompt: string) => Promise<string | null>
  onNamed: (workspaceId: string, sessionId: string) => void
  logger: StructuredAgentSessionLogger
}

export function createStructuredChatNamingHandler(deps: StructuredChatNamingDeps) {
  const inFlight = new Set<string>()
  const logger = neverThrowingStructuredAgentSessionLogger(deps.logger)
  const warn = (sessionId: string, error: unknown) =>
    logger.warn('Chat name generation failed; keeping its first-message title', {
      scope: 'conversation-name',
      sessionId,
      error
    })
  const refresh = (record: AgentSessionRecord) => {
    try {
      deps.onNamed(record.location.workspaceId, record.sessionId)
    } catch (error) {
      warn(record.sessionId, error)
    }
  }

  async function name(summary: AgentSessionStatusSummary) {
    const store = deps.getStore()
    const record = store?.getRecord(summary.sessionId)
    if (
      !store ||
      !record ||
      record.conversationName !== undefined ||
      deps.hasOpenDispatch(record)
    ) {
      return
    }
    let prompt: string
    try {
      prompt = await deps.readFirstPrompt(summary.sessionId)
    } catch (error) {
      warn(summary.sessionId, error)
      prompt = summary.latestPrompt
    }
    const firstPrompt = clampConversationNameFirstPrompt(prompt)
    const placeholder = deriveConversationNamePlaceholder(firstPrompt)
    if (!placeholder) {
      return
    }
    // The durable first-message title settles the attempt, including a failure or restart.
    const seeded = await store.compareAndSetConversationName(summary.sessionId, placeholder, null)
    if (!seeded) {
      return
    }
    refresh(seeded)
    if (deps.getSettings().nativeChatAutoName === false) {
      return
    }
    const generated = await deps.generate(seeded, firstPrompt)
    if (!generated) {
      return
    }
    const named = await store.compareAndSetConversationName(
      summary.sessionId,
      generated,
      seeded.conversationName ?? null
    )
    if (named) {
      refresh(named)
    }
  }

  return (summary: AgentSessionStatusSummary, options: { replay: boolean }): void => {
    if (options.replay || summary.status !== 'working' || inFlight.has(summary.sessionId)) {
      return
    }
    inFlight.add(summary.sessionId)
    void name(summary)
      .catch((error: unknown) => warn(summary.sessionId, error))
      .finally(() => inFlight.delete(summary.sessionId))
  }
}
