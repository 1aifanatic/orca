import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexTurnOpenWaits } from './codex-structured-turn-open-wait'
import type { CodexSession } from './codex-structured-session-state'
import { startCodexTurn } from './codex-structured-turn-start'
import {
  applyCodexStructuredSessionOption,
  readLiveCodexSessionOptions,
  restoredCodexSessionOptions
} from './codex-structured-session-options'
import {
  codexChatPermissionMode,
  codexPermissionModesFor,
  codexTurnPermissionOverrides
} from './codex-structured-permission-mode'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { AgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'

function permissionState(
  picked: string | undefined,
  threadPermissionMode: AgentChatPermissionMode | undefined,
  approvalsReviewerSupported = true
) {
  return {
    options: new Map(picked ? [['permissionMode', picked]] : []),
    ...(threadPermissionMode ? { threadPermissionMode } : {}),
    approvalsReviewerSupported
  }
}

function turnSession(
  request: CodexAppServerConnection['request'],
  threadPermissionMode: AgentChatPermissionMode = 'ask'
): CodexSession {
  return {
    connection: {
      pid: 1,
      closed: false,
      request,
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    },
    backgroundTasks: new CodexBackgroundTaskTracker('thread-1'),
    ended: false,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    threadId: 'thread-1',
    prompts: new CodexAcquisitionWindow().prompts,
    options: new Map(),
    threadPermissionMode,
    approvalsReviewerSupported: true,
    reportedOptions: { model: 'gpt-live', effort: 'high' },
    dispatchEchoes: createCodexDispatchEchoes(),
    turnOpenWaits: createCodexTurnOpenWaits(),
    translator: null
  }
}

function sendTurn(session: CodexSession, id: string): Promise<unknown> {
  return startCodexTurn(session, {
    clientMessageId: id,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] }
  })
}

function recordingRequest() {
  const turns: Record<string, unknown>[] = []
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'turn/start') {
      turns.push(params ?? {})
      return { turn: { id: `turn-${turns.length}` } }
    }
    return method === 'model/list'
      ? { data: [{ model: 'gpt-live', supportedReasoningEfforts: [] }], nextCursor: null }
      : {}
  })
  return { request, turns }
}

describe('codex chat permission mode', () => {
  it('reads the chat pick before the mode its thread opened with', () => {
    expect(codexChatPermissionMode(permissionState('bypass', 'ask'))).toBe('bypass')
    expect(codexChatPermissionMode(permissionState(undefined, 'bypass'))).toBe('bypass')
    expect(codexChatPermissionMode(permissionState('accept-edits', 'ask'))).toBe('ask')
  })

  // An app-server that never reports a reviewer would ignore the routing and keep asking.
  it('reads Approve for me as Ask and withholds it where the app-server has no reviewer routing', () => {
    const state = permissionState('auto', 'ask', false)
    expect(codexPermissionModesFor(state)).toEqual({ current: 'ask', supported: ['ask', 'bypass'] })
    expect(codexPermissionModesFor(permissionState('auto', 'ask'))).toEqual({
      current: 'auto',
      supported: ['ask', 'auto', 'bypass']
    })
  })
})

describe('codexTurnPermissionOverrides', () => {
  it('sends nothing while the thread already runs the chat mode, or the chat never picked', () => {
    expect(codexTurnPermissionOverrides(permissionState('ask', 'ask'))).toBeNull()
    expect(codexTurnPermissionOverrides(permissionState(undefined, 'bypass'))).toBeNull()
  })

  it('moves a sandboxed thread to Full access', () => {
    expect(codexTurnPermissionOverrides(permissionState('bypass', 'ask'))).toEqual({
      mode: 'bypass',
      params: {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'dangerFullAccess' }
      }
    })
  })

  it('moves a Full access thread back into the workspace sandbox with a human reviewer', () => {
    expect(codexTurnPermissionOverrides(permissionState('ask', 'bypass'))).toEqual({
      mode: 'ask',
      params: {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'workspaceWrite' }
      }
    })
  })

  // The turn form replaces the whole sandbox, so it is left alone when only the reviewer moves.
  it('changes only the reviewer between Ask and Approve for me', () => {
    expect(codexTurnPermissionOverrides(permissionState('auto', 'ask'))).toEqual({
      mode: 'auto',
      params: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }
    })
  })
})

describe('codex turn/start under a picked permission mode', () => {
  it('states the new mode on the next turn only, then leaves the thread to keep it', async () => {
    const { request, turns } = recordingRequest()
    const session = turnSession(request, 'ask')

    await sendTurn(session, 'before')
    await applyCodexStructuredSessionOption(session, 'permissionMode', 'bypass')
    await sendTurn(session, 'switched')
    await sendTurn(session, 'after')

    expect(turns[0]).not.toHaveProperty('approvalPolicy')
    expect(turns[1]).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' }
    })
    expect(turns[2]).not.toHaveProperty('approvalPolicy')
    // The stored key is the chat's own and never reaches app-server.
    expect(turns.some((params) => 'permissionMode' in params)).toBe(false)
    expect(session.threadPermissionMode).toBe('bypass')
  })

  it('restates a change again after a turn/start Codex refused', async () => {
    const turns: Record<string, unknown>[] = []
    let refuse = true
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method !== 'turn/start') {
        return {}
      }
      turns.push(params ?? {})
      if (refuse) {
        refuse = false
        throw new Error('turn/start failed')
      }
      return { turn: { id: 'turn-ok' } }
    })
    const session = turnSession(request, 'ask')
    await applyCodexStructuredSessionOption(session, 'permissionMode', 'bypass')

    await expect(sendTurn(session, 'refused')).rejects.toThrow('turn/start failed')
    await sendTurn(session, 'retried')

    expect(turns[1]).toMatchObject({ approvalPolicy: 'never' })
  })
})

describe('codex permission mode option', () => {
  it('refuses a mode Codex has no equivalent for, and auto where it cannot route reviews', async () => {
    const session = turnSession(recordingRequest().request)
    await expect(
      applyCodexStructuredSessionOption(session, 'permissionMode', 'accept-edits')
    ).rejects.toThrow(/no permission mode/)
    session.approvalsReviewerSupported = false
    await expect(
      applyCodexStructuredSessionOption(session, 'permissionMode', 'auto')
    ).rejects.toThrow(/no permission mode/)
  })

  it('keeps a valid stored mode on restore and drops one Codex cannot run', () => {
    expect(restoredCodexSessionOptions({ permissionMode: 'auto' }).get('permissionMode')).toBe(
      'auto'
    )
    expect(
      restoredCodexSessionOptions({ permissionMode: 'accept-edits' }).has('permissionMode')
    ).toBe(false)
  })

  it('publishes the chat mode with the live options', async () => {
    const session = turnSession(recordingRequest().request, 'bypass')
    session.catalogAccess = {
      store: new AgentModelCatalogStore(),
      fingerprint: 'codex-permission-test',
      accountHomePath: '/test-account'
    }

    await expect(readLiveCodexSessionOptions(session, undefined)).resolves.toMatchObject({
      permissionModes: { current: 'bypass', supported: ['ask', 'auto', 'bypass'] }
    })
  })
})
