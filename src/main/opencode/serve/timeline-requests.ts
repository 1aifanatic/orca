import type { ProviderTimelineRequestBody } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { OpenCodePendingRequest, OpenCodeTimelineTranslation } from './timeline-contract'
import type { OpenCodeTimelineState } from './timeline-state'
import { object, requestKey, string, strings, MAX_REQUESTS } from './timeline-shapes'
import { OpenCodeHttpError } from './http-response'

export function openRequest(
  state: OpenCodeTimelineState,
  kind: OpenCodePendingRequest['kind'],
  id: string,
  sessionId: string,
  body: ProviderTimelineRequestBody,
  native: Record<string, unknown>
): OpenCodeTimelineTranslation {
  const request = requestKey(kind, id)
  if (id.length > 512) {
    throw new OpenCodeHttpError('capacity', 'OpenCode request identity exceeds the limit')
  }
  if (state.pending.has(request)) {
    return { events: [] }
  }
  if (state.pending.size >= MAX_REQUESTS) {
    throw new OpenCodeHttpError('capacity', 'OpenCode pending request limit exceeded')
  }
  const retainedNative =
    Buffer.byteLength(JSON.stringify(native), 'utf8') <= 16 * 1024 ? native : { truncated: true }
  const entry: OpenCodePendingRequest =
    kind === 'permission'
      ? {
          kind,
          request,
          nativeId: id,
          sessionId,
          body,
          native: retainedNative,
          permission: (string(native.permission) ?? string(native.action) ?? 'unknown').slice(
            0,
            256
          ),
          patterns: strings(native.patterns ?? native.resources),
          always: strings(native.always ?? native.save)
        }
      : kind === 'question'
        ? {
            kind,
            request,
            nativeId: id,
            sessionId,
            body,
            native: retainedNative,
            questions: body.kind === 'question' ? (body.questions ?? []) : []
          }
        : {
            kind,
            request,
            nativeId: id,
            sessionId,
            body,
            native: retainedNative,
            form: object(retainedNative.form) ?? {}
          }
  state.pending.set(request, entry)
  return {
    events: [{ type: 'request.open', request, body, ...state.join(sessionId) }],
    requests: [entry]
  }
}

export function withdrawRequest(
  state: OpenCodeTimelineState,
  nativeId: string,
  kind?: OpenCodePendingRequest['kind']
): OpenCodeTimelineTranslation {
  const ids: string[] = []
  for (const [request, entry] of state.pending) {
    if (entry.nativeId === nativeId && (!kind || entry.kind === kind)) {
      ids.push(request)
      state.pending.delete(request)
    }
  }
  return {
    events: ids.map((request) => ({ type: 'request.withdrawn', request })),
    withdrawnRequestIds: ids
  }
}
