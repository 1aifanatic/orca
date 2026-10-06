import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import type { OpenCodeWireEvent } from './serve/native-protocol'
import type { OpenCodeSession } from './opencode-structured-session-state'

function workingEvent(type: string): boolean {
  return (
    type === 'message.updated' ||
    type === 'message.part.updated' ||
    type === 'message.part.delta' ||
    type === 'session.execution.started' ||
    type === 'permission.asked' ||
    type === 'question.asked' ||
    type === 'form.created' ||
    type.startsWith('session.tool.') ||
    type.startsWith('session.text.') ||
    type.startsWith('session.reasoning.')
  )
}

export function openCodeChildWorkEvidence(
  session: Pick<OpenCodeSession, 'translator' | 'root' | 'childActive'>,
  event: OpenCodeWireEvent,
  knownSessions: ReadonlySet<string>,
  nativeId: string | null
): AgentChildWorkEvidence[] {
  const translator = session.translator
  const root = session.root
  if (!translator || !root) {
    return []
  }
  const observedAt = event.at ?? Date.now()
  const evidence: AgentChildWorkEvidence[] = []
  const live = (childId: string, restart: boolean, working = true): void => {
    const child = translator.sessions.get(childId)
    if (!child || !translator.ownsSession(childId) || session.childActive.has(childId)) {
      return
    }
    if (working) {
      session.childActive.add(childId)
    }
    evidence.push({
      type: 'live',
      observedAt,
      ...(restart ? { restart: true } : {}),
      child: {
        handle: { idKind: 'thread_id', id: child.id },
        kind: 'agent',
        residency: 'foreground',
        state: working ? 'working' : 'idle',
        ...(child.title ? { name: child.title } : {}),
        ...(child.agent ? { agentType: child.agent } : {}),
        ...(child.parentID && child.parentID !== root.id ? { ownerId: child.parentID } : {}),
        stoppable: false
      }
    })
  }
  for (const child of translator.sessions.values()) {
    if (child.id !== root.id && !knownSessions.has(child.id)) {
      live(child.id, false, false)
    }
  }
  if (!nativeId || nativeId === root.id || !translator.ownsSession(nativeId)) {
    return evidence
  }
  const terminal =
    (event.type === 'session.status' &&
      event.data.status &&
      typeof event.data.status === 'object' &&
      'type' in event.data.status &&
      event.data.status.type === 'idle') ||
    event.type === 'session.idle' ||
    event.type === 'session.execution.succeeded' ||
    event.type === 'session.execution.failed' ||
    event.type === 'session.execution.interrupted'
  if (terminal) {
    if (session.childActive.delete(nativeId)) {
      evidence.push({
        type: 'ended',
        observedAt,
        handle: { idKind: 'thread_id', id: nativeId },
        outcome: event.type.includes('failed')
          ? 'failed'
          : event.type.includes('interrupted')
            ? 'cancelled'
            : 'succeeded'
      })
    }
  } else if (
    workingEvent(event.type) ||
    (event.type === 'session.status' &&
      event.data.status &&
      typeof event.data.status === 'object' &&
      'type' in event.data.status &&
      event.data.status.type === 'busy')
  ) {
    live(nativeId, knownSessions.has(nativeId))
  }
  return evidence
}
