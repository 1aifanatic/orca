import { randomBytes } from 'node:crypto'
import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { openCodeSelectedModel } from './serve/session-catalog'
import { openCodeUserIdentity } from './opencode-structured-session-identity'
import {
  OpenCodeAttachmentError,
  prepareOpenCodePromptContent
} from './opencode-structured-prompt-content'
import { OpenCodeHttpError } from './serve/http-response'
import type { OpenCodeSession } from './opencode-structured-session-state'

export type OpenCodeDispatchSession = Pick<
  OpenCodeSession,
  | 'launch'
  | 'client'
  | 'root'
  | 'translator'
  | 'ready'
  | 'ended'
  | 'fence'
  | 'closing'
  | 'commands'
  | 'optionValues'
  | 'outstanding'
  | 'dispatchOrder'
  | 'inputRecorded'
  | 'lane'
>

let messageIdMillis = -1
let messageIdCounter = 0

function mintOpenCodeMessageId(): string {
  const now = Date.now()
  messageIdCounter = now === messageIdMillis ? (messageIdCounter + 1) & 0xfff : 1
  messageIdMillis = now
  const time = BigInt.asUintN(48, BigInt(now) * 0x1000n + BigInt(messageIdCounter))
    .toString(16)
    .padStart(12, '0')
  return `msg_${time}${randomBytes(14).toString('hex')}`
}

/** A server write is never retried: a transport failure may have taken the message. */
export async function dispatchOpenCodeSession(
  session: OpenCodeDispatchSession,
  input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
    requestedAt?: number
    beforeDispatch?: () => Promise<void>
  }
): Promise<AgentSessionDispatchOutcome> {
  const client = session.client
  const root = session.root
  const translator = session.translator
  if (
    !client ||
    !root ||
    !translator ||
    !session.ready ||
    session.ended ||
    input.fence !== session.fence
  ) {
    return { state: 'unknown', reason: 'OpenCode session is not ready' }
  }
  let content
  try {
    content = await prepareOpenCodePromptContent(input.body)
  } catch (error) {
    if (error instanceof OpenCodeAttachmentError) {
      return {
        state: 'rejected',
        ...agentSessionFailureWords(error.failure, { surface: 'rejection' })
      }
    }
    throw error
  }
  const { text, files } = content
  if (!text.trim() && files.length === 0) {
    return {
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('emptyMessage'), { surface: 'rejection' })
    }
  }
  let command: { name: string; argumentsText: string } | null = null
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text)
  if (match && session.commands.some((command) => command.name === match[1])) {
    command = { name: match[1]!, argumentsText: match[2] ?? '' }
  }
  await input.beforeDispatch?.()
  try {
    if (session.ended || session.closing || !session.ready) {
      return { state: 'unknown', reason: 'OpenCode session closed before dispatch' }
    }
    if (session.outstanding.size >= 128) {
      return {
        state: 'rejected',
        ...agentSessionFailureWords(
          agentSessionFailureFact('providerRejected', {
            detail: providerDiagnosticOf(new Error('OpenCode has too many unconfirmed messages'))
          }),
          { surface: 'rejection' }
        )
      }
    }
    const model = openCodeSelectedModel(session.optionValues)
    const requestedAt = input.requestedAt ?? Date.now()
    const nativeMessageId = client.version.major === 1 ? mintOpenCodeMessageId() : null
    session.outstanding.set(input.clientMessageId, nativeMessageId)
    session.dispatchOrder.push({ clientMessageId: input.clientMessageId, requestedAt })
    if (command) {
      await client.command(
        root.id,
        command.name,
        command.argumentsText,
        model,
        session.optionValues.mode,
        nativeMessageId ?? undefined,
        files
      )
      return { state: 'admitted' }
    }
    const answer = await client.prompt({
      sessionId: root.id,
      text,
      files,
      ...(model ? { model } : {}),
      ...(nativeMessageId ? { nativeMessageId } : {}),
      ...(session.optionValues.mode ? { mode: session.optionValues.mode } : {})
    })
    if (session.outstanding.has(input.clientMessageId)) {
      session.outstanding.set(input.clientMessageId, answer.nativeMessageId)
    }
    if (client.version.major === 2 && answer.nativeMessageId) {
      if (
        session.outstanding.has(input.clientMessageId) &&
        !session.inputRecorded.has(input.clientMessageId)
      ) {
        await session.lane?.apply(
          translator.input(input.clientMessageId, requestedAt, answer.nativeMessageId)
        )
      }
      session.outstanding.delete(input.clientMessageId)
      session.dispatchOrder = session.dispatchOrder.filter(
        (entry) => entry.clientMessageId !== input.clientMessageId
      )
      session.inputRecorded.delete(input.clientMessageId)
      return {
        state: 'accepted',
        providerIdentity: openCodeUserIdentity({
          agent: session.launch.agent,
          sessionId: input.sessionId,
          nativeSessionId: root.id,
          nativeMessageId: answer.nativeMessageId
        })
      }
    }
    return { state: 'admitted' }
  } catch (error) {
    if (
      error instanceof OpenCodeHttpError &&
      error.kind === 'status' &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500
    ) {
      session.outstanding.delete(input.clientMessageId)
      session.dispatchOrder = session.dispatchOrder.filter(
        (entry) => entry.clientMessageId !== input.clientMessageId
      )
      return {
        state: 'rejected',
        ...agentSessionFailureWords(
          agentSessionFailureFact('providerRejected', { detail: providerDiagnosticOf(error) }),
          { surface: 'rejection' }
        )
      }
    }
    return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
}
