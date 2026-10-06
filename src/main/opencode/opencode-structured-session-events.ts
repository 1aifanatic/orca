import type { OpenCodeWireEvent } from './serve/native-protocol'
import { openCodeChildPermissionRules } from './opencode-structured-permission-policy'
import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'
import { proveOpenCodeSessionAncestry } from './opencode-structured-session-ancestry'
import { observeOpenCodeOptions } from './opencode-structured-session-options'
import { openCodeUserIdentity } from './opencode-structured-session-identity'
import { settleOpenCodeIdleDispatches } from './opencode-structured-session-idle'
import { openCodeChildWorkEvidence } from './opencode-structured-session-child-work'
import type {
  OpenCodeSession,
  OpenCodeStructuredSessionAdapterDeps
} from './opencode-structured-session-state'

const MAX_HELD_FRAMES = 512
const MAX_HELD_BYTES = 32 * 1024 * 1024

function eventSessionId(event: OpenCodeWireEvent): string | null {
  const direct = event.data.sessionID
  if (typeof direct === 'string') {
    return direct
  }
  for (const value of [event.data.part, event.data.form, event.data.info]) {
    if (
      value &&
      typeof value === 'object' &&
      'sessionID' in value &&
      typeof value.sessionID === 'string'
    ) {
      return value.sessionID
    }
  }
  return null
}

export class OpenCodeStructuredSessionEvents {
  constructor(
    private readonly sessions: Map<string, OpenCodeSession>,
    private readonly deps: OpenCodeStructuredSessionAdapterDeps
  ) {}

  private isCurrent(session: OpenCodeSession): boolean {
    return this.sessions.get(session.sessionId) === session && !session.ended
  }

  private publish(sessionId: string, scope: string, action: () => void): boolean {
    try {
      action()
      return true
    } catch (error) {
      this.deps.logger?.error('OpenCode event bookkeeping failed', { scope, sessionId, error })
      return false
    }
  }

  onFrame(session: OpenCodeSession, event: OpenCodeWireEvent): Promise<void> {
    return session.eventQueue.serialize('frames', () => this.applyFrame(session, event))
  }

  activate(session: OpenCodeSession): Promise<void> {
    return session.eventQueue.serialize('frames', async () => {
      session.ready = true
      const held = session.heldFrames.splice(0)
      session.heldFrameBytes = 0
      for (const event of held) {
        await this.applyFrame(session, event)
      }
    })
  }

  private async applyFrame(session: OpenCodeSession, event: OpenCodeWireEvent): Promise<void> {
    if (!this.isCurrent(session)) {
      return
    }
    if (!session.ready) {
      if (session.heldFrames.length >= MAX_HELD_FRAMES) {
        throw new Error('OpenCode startup event buffer exceeded')
      }
      const { byteLength } = stringifyJsonWithinByteLimit(event, MAX_HELD_BYTES)
      if (session.heldFrameBytes + byteLength > MAX_HELD_BYTES) {
        throw new Error('OpenCode startup event bytes exceeded')
      }
      session.heldFrameBytes += byteLength
      session.heldFrames.push(event)
      return
    }
    const translator = session.translator
    const client = session.client
    const root = session.root
    if (!translator || !client || !root) {
      return
    }
    const knownSessions = new Set(translator.sessions.keys())
    const nativeId = eventSessionId(event)
    if (nativeId && !translator.ownsSession(nativeId)) {
      if (event.type === 'session.created' || event.type === 'session.updated') {
        const info = event.data.info
        const parentId =
          typeof event.data.parentID === 'string'
            ? event.data.parentID
            : info &&
                typeof info === 'object' &&
                'parentID' in info &&
                typeof info.parentID === 'string'
              ? info.parentID
              : null
        if (
          !parentId ||
          !(await proveOpenCodeSessionAncestry(session, parentId, () => this.isCurrent(session)))
        ) {
          return
        }
      } else if (
        !(await proveOpenCodeSessionAncestry(session, nativeId, () => this.isCurrent(session)))
      ) {
        return
      }
    }
    if (!this.isCurrent(session)) {
      return
    }
    const info = event.data.info
    const observedInputId =
      nativeId === root.id &&
      client.version.major === 1 &&
      event.type === 'message.updated' &&
      info &&
      typeof info === 'object' &&
      'role' in info &&
      info.role === 'user' &&
      'id' in info &&
      typeof info.id === 'string'
        ? info.id
        : nativeId === root.id &&
            client.version.major === 2 &&
            (event.type === 'session.inbox.enqueued' || event.type === 'session.inbox.delivered') &&
            typeof event.data.inboxID === 'string'
          ? event.data.inboxID
          : null
    const next = session.dispatchOrder[0]
    if (
      observedInputId &&
      next &&
      !translator.accepted.has(observedInputId) &&
      !session.inputRecorded.has(next.clientMessageId)
    ) {
      const expected = session.outstanding.get(next.clientMessageId)
      if (expected === null || expected === observedInputId) {
        await session.lane?.apply(
          translator.input(next.clientMessageId, next.requestedAt, observedInputId)
        )
        session.inputRecorded.add(next.clientMessageId)
      }
    }
    observeOpenCodeOptions(session, event)
    const translated = translator.translate(event, event.at ?? Date.now())
    if (event.type === 'session.created' && client.version.major === 1) {
      for (const child of translated.children ?? []) {
        await client.patchPermissions(
          child.id,
          openCodeChildPermissionRules({
            major: 1,
            parentRules: session.launch.permissions,
            childRules: child.permission ?? []
          })
        )
      }
    }
    if (!this.isCurrent(session)) {
      return
    }
    await session.lane?.apply(translated.events)
    if (!this.isCurrent(session)) {
      return
    }
    for (const request of translated.requests ?? []) {
      session.pending.set(request.request, request)
    }
    for (const requestId of translated.withdrawnRequestIds ?? []) {
      session.pending.delete(requestId)
    }
    for (const acceptedId of translated.acceptedNativeMessageIds ?? []) {
      const head = session.dispatchOrder[0]
      if (!head) {
        break
      }
      const expected = session.outstanding.get(head.clientMessageId)
      if (expected !== null && expected !== acceptedId) {
        continue
      }
      const next = session.dispatchOrder.shift()!
      session.outstanding.delete(next.clientMessageId)
      session.inputRecorded.delete(next.clientMessageId)
      this.publish(session.sessionId, 'opencode-dispatch-settlement', () =>
        this.deps.onDispatchSettledLate?.({
          sessionId: session.sessionId,
          clientMessageId: next.clientMessageId,
          providerIdentity: openCodeUserIdentity({
            agent: session.launch.agent,
            sessionId: session.sessionId,
            nativeSessionId: root.id,
            nativeMessageId: acceptedId
          })
        })
      )
    }
    const previouslyActive = new Set(session.childActive)
    const childEvidence = openCodeChildWorkEvidence(session, event, knownSessions, nativeId)
    if (childEvidence.length > 0) {
      const published = this.publish(session.sessionId, 'opencode-child-work', () =>
        this.deps.onChildWorkEvidence?.(session.sessionId, childEvidence)
      )
      if (!published) {
        session.childActive = previouslyActive
      }
    }
    settleOpenCodeIdleDispatches(session, this.deps, translated.rootIdle)
  }
}
