import { describe, expect, it, vi } from 'vitest'
import { OpenCodeHttpPeer } from './http-peer'
import { OpenCodeSessionClient } from './session-client'
import type { OpenCodePendingRequest } from './timeline-translator'
import type { AgentJournalQuestionItem } from '../../../shared/agent-session-journal-types'

function client(major: 1 | 2, fetchImpl: typeof fetch) {
  const peer = new OpenCodeHttpPeer({ port: 48171, password: 'fixture-password', fetch: fetchImpl })
  return new OpenCodeSessionClient(
    peer,
    { major, version: major === 1 ? '1.18.31' : '2.0.14' },
    '/project'
  )
}

function nativeQuestion(kind: 'question' | 'form'): OpenCodePendingRequest {
  const body: AgentJournalQuestionItem = {
    kind: 'question',
    question: 'Colors?',
    options: [],
    questions: [
      {
        id: 'q0',
        question: 'Colors?',
        multiSelect: true,
        options: [
          { id: 'Red', label: 'Red' },
          { id: 'Blue', label: 'Blue' }
        ]
      },
      { id: 'q1', question: 'Nickname?', multiSelect: false, options: [], freeTextQuestionId: 'q1' }
    ],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
  const common = { request: `${kind}:q`, nativeId: 'q', sessionId: 'child', native: {}, body }
  return kind === 'question' ? { ...common, kind, questions: [] } : { ...common, kind, form: {} }
}

describe('recorded OpenCode HTTP controls', () => {
  it.each([1, 2] as const)(
    'keeps image-only and command attachments on the recorded file URI path in dialect %s',
    async (major) => {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        major === 1
          ? new Response(null, { status: 204 })
          : Response.json({ data: { id: 'msg_image' } })
      )
      const connection = client(major, fetchImpl)
      const file = {
        uri: 'file:///workspace/red-blue.png',
        name: 'red-blue.png',
        mime: 'image/png'
      }
      await connection.prompt({ sessionId: 'root', text: '', files: [file] })
      expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(
        JSON.stringify(
          major === 1
            ? { parts: [{ type: 'file', mime: file.mime, filename: file.name, url: file.uri }] }
            : { text: '', files: [{ uri: file.uri, name: file.name }] }
        )
      )
      await connection.command('root', 'captureimage', '', undefined, undefined, undefined, [file])
      expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe(
        JSON.stringify(
          major === 1
            ? {
                command: 'captureimage',
                arguments: '',
                parts: [{ type: 'file', mime: file.mime, filename: file.name, url: file.uri }]
              }
            : { name: 'captureimage', text: '', files: [{ uri: file.uri, name: file.name }] }
        )
      )
      connection.peer.close()
    }
  )
  it.each([1, 2] as const)(
    'answers grouped questions with selected values and free text in dialect %s',
    async (major) => {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        major === 1 ? Response.json(true) : new Response(null, { status: 204 })
      )
      const connection = client(major, fetchImpl)
      await connection.answerPrompt(nativeQuestion(major === 1 ? 'question' : 'form'), {
        kind: 'answers',
        answers: [
          { questionId: 'q1', optionIds: [], other: 'custom' },
          { questionId: 'q0', optionIds: ['Red', 'Blue'] }
        ]
      })
      expect(fetchImpl).toHaveBeenCalledWith(
        `http://127.0.0.1:48171${major === 1 ? '/question/q/reply' : '/api/session/child/form/q/reply'}`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(
            major === 1
              ? { answers: [['Red', 'Blue'], ['custom']] }
              : { answer: { q0: ['Red', 'Blue'], q1: 'custom' } }
          )
        })
      )
      connection.peer.close()
    }
  )

  it('rejects duplicate or unavailable grouped answers before any native mutation', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(true))
    const connection = client(1, fetchImpl)
    await expect(
      connection.answerPrompt(nativeQuestion('question'), {
        kind: 'answers',
        answers: [
          { questionId: 'q0', optionIds: ['unavailable'] },
          { questionId: 'q1', optionIds: [], other: 'custom' }
        ]
      })
    ).rejects.toThrow('invalid')
    expect(fetchImpl).not.toHaveBeenCalled()
    connection.peer.close()
  })

  it.each([1, 2] as const)(
    'declines without promoting the decision to project-wide always in dialect %s',
    async (major) => {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        major === 1 ? Response.json(true) : new Response(null, { status: 204 })
      )
      const connection = client(major, fetchImpl)
      await connection.answerPermission({
        sessionId: 'child',
        requestId: 'ask',
        decision: 'reject',
        message: 'The user declined this request.'
      })
      expect(fetchImpl).toHaveBeenCalledWith(
        `http://127.0.0.1:48171${major === 1 ? '/permission/ask/reply' : '/api/session/child/permission/ask/reply'}`,
        expect.objectContaining({
          body: JSON.stringify(
            major === 1
              ? { reply: 'reject' }
              : { decision: 'reject', message: 'The user declined this request.' }
          )
        })
      )
      connection.peer.close()
    }
  )

  it('does not retry an ambiguous native command mutation', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('disconnected')
    })
    const connection = client(2, fetchImpl)
    await expect(connection.command('root', 'loaded-command', 'text')).rejects.toMatchObject({
      kind: 'transport'
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:48171/api/session/root/command',
      expect.objectContaining({ body: '{"name":"loaded-command","text":"text"}' })
    )
    connection.peer.close()
  })

  it('keeps selected v1 mode, variant and receipt identity on a native command', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}))
    const connection = client(1, fetchImpl)
    await connection.command(
      'root',
      'loaded-command',
      'text',
      { providerID: 'vendor', id: 'model', variant: 'high' },
      'plan',
      'msg_receipt'
    )
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:48171/session/root/command',
      expect.objectContaining({
        body: JSON.stringify({
          command: 'loaded-command',
          arguments: 'text',
          messageID: 'msg_receipt',
          agent: 'plan',
          variant: 'high',
          model: 'vendor/model'
        })
      })
    )
    connection.peer.close()
  })
})
