import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

export type StructuredSubjectRead = {
  sessionId: string
  target: RuntimeClientTarget
  observedCursor: AgentJournalCursor
  observationKey: string
}
export type AgentSubjectRead = { subjectKey: string; structured?: StructuredSubjectRead }

const captures = new Map<string, () => StructuredSubjectRead | null>()
const listeners = new Set<(reads: readonly AgentSubjectRead[]) => void>()
const viewListeners = new Set<(read: StructuredSubjectRead) => void>()

export function registerAgentSubjectReadCapture(
  subjectKey: string,
  capture: () => StructuredSubjectRead | null
): () => void {
  captures.set(subjectKey, capture)
  return () => {
    if (captures.get(subjectKey) === capture) {
      captures.delete(subjectKey)
    }
  }
}

export function captureAgentSubjectReads(subjectKeys: readonly string[]): AgentSubjectRead[] {
  return subjectKeys.map((subjectKey) => {
    try {
      const structured = captures.get(subjectKey)?.()
      return { subjectKey, ...(structured ? { structured } : {}) }
    } catch (error) {
      console.warn('[agent-subject-read] could not capture accepted view', error)
      return { subjectKey }
    }
  })
}

export function emitAgentSubjectReads(
  subjectKeys: readonly string[],
  captured?: readonly AgentSubjectRead[]
): void {
  const reads =
    captured === undefined
      ? captureAgentSubjectReads(subjectKeys)
      : captured.filter((read) => subjectKeys.includes(read.subjectKey))
  for (const listener of listeners) {
    try {
      listener(reads)
    } catch (error) {
      console.warn('[agent-subject-read] retirement failed', error)
    }
  }
}

export function subscribeAgentSubjectReads(
  listener: (reads: readonly AgentSubjectRead[]) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifyStructuredAttentionView(read: StructuredSubjectRead): void {
  for (const listener of viewListeners) {
    try {
      listener(read)
    } catch (error) {
      console.warn('[agent-subject-read] view evaluation failed', error)
    }
  }
}

export function subscribeStructuredAttentionViews(
  listener: (read: StructuredSubjectRead) => void
): () => void {
  viewListeners.add(listener)
  return () => {
    viewListeners.delete(listener)
  }
}

export function sameStructuredReadTarget(
  left: RuntimeClientTarget,
  right: RuntimeClientTarget
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'local' ||
      (right.kind === 'environment' && left.environmentId === right.environmentId))
  )
}
