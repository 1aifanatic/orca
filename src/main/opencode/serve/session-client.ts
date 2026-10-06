import type { OpenCodeHttpPeer } from './http-peer'
import type { AgentSessionPromptResponse } from '../../../shared/agent-session-question-answer'
import type { OpenCodePendingRequest } from './timeline-translator'
import { readOpenCodeSessionCatalog, setOpenCodeSessionOption } from './session-catalog'
import {
  answerOpenCodePrompt,
  compactOpenCodeSession,
  runOpenCodeCommand
} from './session-controls'
import { readOpenCodeHistory } from './session-history'
import { OpenCodeHttpError } from './http-response'
import type { OpenCodeServerVersion } from './server-probe'
import type { OpenCodePromptFile } from '../opencode-structured-prompt-content'
import {
  openCodeV2PermissionRules,
  openCodeObjectSchema,
  readOpenCodeSession,
  readOpenCodeWireEvent,
  type OpenCodeModel,
  type OpenCodeNativeSession,
  type OpenCodePermissionRule,
  type OpenCodeWireEvent
} from './native-protocol'

/** The two recorded server dialects share ownership, never request paths or payloads. */
export class OpenCodeSessionClient {
  constructor(
    readonly peer: OpenCodeHttpPeer,
    readonly version: OpenCodeServerVersion,
    readonly directory: string
  ) {}

  async create(input: {
    permissions: readonly OpenCodePermissionRule[]
    model?: OpenCodeModel
  }): Promise<OpenCodeNativeSession> {
    const body =
      this.version.major === 1
        ? { permission: input.permissions }
        : {
            location: { directory: this.directory },
            permissions: openCodeV2PermissionRules(input.permissions),
            ...(input.model ? { model: input.model } : {})
          }
    return readOpenCodeSession(
      await this.peer.json(this.path('/session'), { method: 'POST', body }),
      this.version.major
    )
  }

  async load(sessionId: string, signal?: AbortSignal): Promise<OpenCodeNativeSession> {
    const session = readOpenCodeSession(
      await this.peer.json(this.sessionPath(sessionId), { signal }),
      this.version.major
    )
    if (session.id !== sessionId) {
      throw new OpenCodeHttpError('invalid-response', 'OpenCode loaded a different session')
    }
    return session
  }

  async prompt(input: {
    sessionId: string
    text: string
    model?: OpenCodeModel
    nativeMessageId?: string
    mode?: string
    files?: readonly OpenCodePromptFile[]
  }): Promise<{ nativeMessageId: string | null }> {
    const v1 = this.version.major === 1
    const result = await this.peer.json(
      this.sessionPath(input.sessionId, v1 ? '/prompt_async' : '/prompt'),
      {
        method: 'POST',
        body: v1
          ? {
              parts: [
                ...(input.text ? [{ type: 'text', text: input.text }] : []),
                ...(input.files ?? []).map((file) => ({
                  type: 'file',
                  mime: file.mime,
                  filename: file.name,
                  url: file.uri
                }))
              ],
              ...(input.nativeMessageId ? { messageID: input.nativeMessageId } : {}),
              ...(input.mode ? { agent: input.mode } : {}),
              ...(input.model?.variant ? { variant: input.model.variant } : {}),
              ...(input.model
                ? { model: { providerID: input.model.providerID, modelID: input.model.id } }
                : {})
            }
          : {
              text: input.text,
              ...(input.files?.length
                ? { files: input.files.map(({ uri, name }) => ({ uri, name })) }
                : {})
            }
      }
    )
    const envelope = openCodeObjectSchema.safeParse(result)
    const data = openCodeObjectSchema.safeParse(envelope.success ? envelope.data.data : null)
    return {
      nativeMessageId: v1
        ? (input.nativeMessageId ?? null)
        : data.success && typeof data.data.id === 'string'
          ? data.data.id
          : null
    }
  }

  history(sessionId: string): Promise<unknown> {
    return readOpenCodeHistory(this, sessionId)
  }

  async patchPermissions(
    sessionId: string,
    rules: readonly OpenCodePermissionRule[],
    signal?: AbortSignal
  ): Promise<void> {
    await this.peer.json(this.sessionPath(sessionId), {
      method: 'PATCH',
      signal,
      body:
        this.version.major === 1
          ? { permission: rules }
          : { permissions: openCodeV2PermissionRules(rules) }
    })
  }

  answerPrompt(
    request: OpenCodePendingRequest,
    response: AgentSessionPromptResponse
  ): Promise<void> {
    return answerOpenCodePrompt(this, request, response)
  }

  compact(sessionId: string, model?: OpenCodeModel): Promise<void> {
    return compactOpenCodeSession(this, sessionId, model)
  }

  command(
    sessionId: string,
    name: string,
    argumentsText: string,
    model?: OpenCodeModel,
    mode?: string,
    nativeMessageId?: string,
    files?: readonly OpenCodePromptFile[]
  ): Promise<void> {
    return runOpenCodeCommand(
      this,
      sessionId,
      name,
      argumentsText,
      model,
      mode,
      nativeMessageId,
      files
    )
  }

  readCatalog(sessionId?: string) {
    return readOpenCodeSessionCatalog(this, sessionId)
  }

  setOption(
    sessionId: string,
    key: string,
    value: string,
    options: Readonly<Record<string, string>>
  ): Promise<Record<string, string>> {
    return setOpenCodeSessionOption(this, sessionId, key, value, options)
  }

  async abort(sessionId: string): Promise<void> {
    await this.peer.json(
      this.sessionPath(sessionId, this.version.major === 1 ? '/abort' : '/interrupt'),
      {
        method: 'POST',
        ...(this.version.major === 2 ? { body: {} } : {}),
        timeoutMs: 4_000
      }
    )
  }

  async answerPermission(input: {
    sessionId: string
    requestId: string
    decision: 'once' | 'reject'
    message?: string
  }): Promise<void> {
    const v1 = this.version.major === 1
    const request = encodeURIComponent(input.requestId)
    await this.peer.json(
      v1
        ? `/permission/${request}/reply`
        : this.sessionPath(input.sessionId, `/permission/${request}/reply`),
      {
        method: 'POST',
        body: v1
          ? { reply: input.decision }
          : { decision: input.decision, ...(input.message ? { message: input.message } : {}) }
      }
    )
  }

  async events(
    onEvent: (event: OpenCodeWireEvent) => Promise<void>,
    signal: AbortSignal
  ): Promise<void> {
    await this.peer.events(
      this.path('/event'),
      async ({ data }) => {
        let value: unknown
        try {
          value = JSON.parse(data)
        } catch {
          throw new OpenCodeHttpError('invalid-response', 'OpenCode sent invalid event JSON')
        }
        await onEvent(readOpenCodeWireEvent(value, this.version.major))
      },
      signal
    )
  }

  sessionPath(sessionId: string, suffix = ''): string {
    return this.path(`/session/${encodeURIComponent(sessionId)}${suffix}`)
  }

  path(path: string): string {
    return this.version.major === 1 ? path : `/api${path}`
  }
}
