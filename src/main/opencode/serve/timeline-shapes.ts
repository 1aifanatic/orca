import type {
  ProviderTimelineEvent,
  ProviderTimelineRequestBody
} from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { OpenCodePendingRequest } from './timeline-contract'
import { redactString } from '../../observability/redactor'
import { OpenCodeHttpError } from './http-response'
import { isRecord } from '../../../shared/agent-status-child-work-value-guards'

export const MAX_TEXT = 64 * 1024
export const MAX_PARTS = 512
export const MAX_SESSIONS = 256
export const MAX_REQUESTS = 128

export function object(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function valueAt(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value
  for (const key of keys) {
    current = object(current)?.[key]
  }
  return current
}

export function textContent(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return array(value)
    .map((entry) => string(object(entry)?.text) ?? '')
    .filter(Boolean)
    .join('\n')
}

export function approvalBody(
  permission: string,
  patterns: string[],
  allowSession: boolean
): ProviderTimelineRequestBody {
  return {
    kind: 'approval',
    title: permission === 'shell' || permission === 'bash' ? 'Run command?' : 'Allow access?',
    ...(permission === 'external_directory'
      ? { blockedPath: patterns[0]?.replace(/[\\/]\*$/, '') }
      : { displayName: permission.slice(0, 256) }),
    detail: patterns.join('\n') || null,
    options: [
      { id: 'once', label: 'Allow once' },
      ...(allowSession ? [{ id: 'allow-session', label: 'Allow for this chat' }] : []),
      { id: 'reject', label: 'Deny' }
    ],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}

export function questionBody(value: unknown): ProviderTimelineRequestBody {
  const questions = array(value)
    .slice(0, 16)
    .map((candidate, index) => {
      const question = object(candidate) ?? {}
      if (typeof question.key === 'string' && question.key.length > 512) {
        throw new OpenCodeHttpError('capacity', 'OpenCode question identity exceeds the limit')
      }
      const options = array(question.options)
        .slice(0, 16)
        .map((option) => object(option) ?? {})
        .map((option, optionIndex) => {
          const description = string(option.description)
          return {
            id: (string(option.value) ?? string(option.label) ?? `option-${optionIndex}`).slice(
              0,
              200
            ),
            label: (
              string(option.label) ??
              string(option.value) ??
              `Option ${optionIndex + 1}`
            ).slice(0, 200),
            ...(description ? { description: description.slice(0, 256) } : {})
          }
        })
      const header = string(question.header) ?? string(question.title)
      return {
        id: string(question.key) ?? `q${index}`,
        question: (
          string(question.question) ??
          string(question.description) ??
          string(question.title) ??
          'Question'
        ).slice(0, 1000),
        ...(header ? { header: header.slice(0, 200) } : {}),
        multiSelect: question.multiple === true || question.type === 'multiselect',
        options,
        ...(question.custom === true ||
        question.type === 'string' ||
        options.length === 0 ||
        (string(question.question) !== undefined && question.custom !== false)
          ? { freeTextQuestionId: string(question.key) ?? `q${index}` }
          : {})
      }
    })
  return {
    kind: 'question',
    question: questions[0]?.question ?? 'Questions',
    options: questions[0]?.options ?? [],
    questions,
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}

export function remember<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  if (typeof key === 'string' && key.length > 2048) {
    throw new OpenCodeHttpError('capacity', 'OpenCode timeline identity exceeds the limit')
  }
  if (typeof value === 'string' && value.length > 512) {
    throw new OpenCodeHttpError('capacity', 'OpenCode timeline reference exceeds the limit')
  }
  map.delete(key)
  map.set(key, value)
  if (map.size > limit) {
    const oldest = map.keys().next()
    if (!oldest.done) {
      map.delete(oldest.value)
    }
  }
}

export function strings(value: unknown): string[] {
  return array(value)
    .slice(0, 32)
    .flatMap((entry) => (typeof entry === 'string' ? [entry.slice(0, 2048)] : []))
}

export function usage(
  tokens: unknown,
  at: number,
  contextWindowTokens?: number | null
): ProviderTimelineEvent | undefined {
  const t = object(tokens)
  if (!t || number(t.input) === undefined) {
    return undefined
  }
  const cache = object(t.cache)
  return {
    type: 'context.usage',
    usage: {
      ...(contextWindowTokens &&
      Number.isSafeInteger(contextWindowTokens) &&
      contextWindowTokens > 0
        ? { window: { tokens: contextWindowTokens, capturedAt: at } }
        : {}),
      used: {
        kind: 'estimate',
        capturedAt: at,
        usage: {
          inputTokens: number(t.input) ?? 0,
          outputTokens: number(t.output) ?? 0,
          cacheReadInputTokens: number(cache?.read) ?? 0,
          cacheCreationInputTokens: number(cache?.write) ?? 0
        }
      }
    }
  }
}

export function errorWords(value: unknown): string {
  const error = object(value)
  const data = object(error?.data)
  return redactString(
    string(error?.message) ??
      string(data?.message) ??
      string(error?.name) ??
      'OpenCode reported an error'
  ).slice(0, 512)
}

export function terminalState(value: unknown): 'completed' | 'failed' | 'running' {
  return value === 'completed'
    ? 'completed'
    : value === 'error' || value === 'failed'
      ? 'failed'
      : 'running'
}

export function requestKey(kind: OpenCodePendingRequest['kind'], id: string): string {
  return `${kind}:${id}`
}
