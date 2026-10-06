import { describe, expect, it } from 'vitest'
import { OpenCodeHttpPeer } from './serve/http-peer'
import { OpenCodeSessionClient } from './serve/session-client'
import { OpenCodeTimelineTranslator } from './serve/timeline-translator'
import {
  dispatchOpenCodeSession,
  type OpenCodeDispatchSession
} from './opencode-structured-session-dispatch'

function fixture(major: 1 | 2, respond: 'ok' | 'transport' = 'ok') {
  const calls: { url: string; body: unknown }[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null })
    if (respond === 'transport') {
      throw new Error('connection ended after write')
    }
    const body =
      major === 2 && String(input).endsWith('/prompt') ? '{"data":{"id":"msg-native"}}' : '{}'
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = new OpenCodeSessionClient(
    new OpenCodeHttpPeer({ port: 47998, password: 'secret', fetch: fetchImpl }),
    { major, version: major === 1 ? '1.18.31' : '2.0.14' },
    '/workspace'
  )
  const session: OpenCodeDispatchSession = {
    launch: {
      command: 'opencode',
      cwd: '/workspace',
      environment: {},
      resumeSessionId: null,
      permissions: [],
      agent: major === 1 ? 'opencode' : 'opencode2'
    },
    client,
    root: { id: 'root' },
    translator: new OpenCodeTimelineTranslator({ sessionId: 'root', major }),
    lane: null,
    ready: true,
    ended: false,
    closing: null,
    fence: 4,
    commands: [{ name: 'review', kind: 'command' }],
    optionValues: {},
    outstanding: new Map(),
    dispatchOrder: [],
    inputRecorded: new Set()
  }
  const send = (text: string, beforeDispatch?: () => Promise<void>) =>
    dispatchOpenCodeSession(session, {
      sessionId: 'chat',
      clientMessageId: 'message-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
      fence: 4,
      requestedAt: 100,
      ...(beforeDispatch ? { beforeDispatch } : {})
    })
  return { calls, session, send }
}

describe('OpenCode structured dispatch', () => {
  it('sends an unlisted slash path as literal text with a native message identity', async () => {
    const { calls, session, send } = fixture(1)
    expect(await send('/tmp/report')).toEqual({ state: 'admitted' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/session/root/prompt_async')
    expect(calls[0]?.body).toMatchObject({ parts: [{ type: 'text', text: '/tmp/report' }] })
    expect(session.outstanding.get('message-1')).toMatch(/^msg_[0-9a-f]{40}$/)
  })

  it('routes only a loaded named command to the command endpoint', async () => {
    const { calls, send } = fixture(2)
    expect(await send('/review src')).toEqual({ state: 'admitted' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/api/session/root/command')
    expect(calls[0]?.body).toMatchObject({ name: 'review', text: 'src' })
  })

  it('treats the native 2.x prompt receipt as admission', async () => {
    const { calls, session, send } = fixture(2)
    expect(await send('do work')).toEqual({
      state: 'accepted',
      providerIdentity: {
        provider: 'legacy',
        agent: 'opencode2',
        sessionId: 'chat',
        recordId: 'item:p:root:msg-native'
      }
    })
    expect(calls).toHaveLength(1)
    expect(session.outstanding.size).toBe(0)
  })

  it('does not retry a write whose transport outcome is unknown', async () => {
    const { calls, session, send } = fixture(2, 'transport')
    expect(await send('do work')).toMatchObject({ state: 'unknown' })
    expect(calls).toHaveLength(1)
    expect(session.outstanding.has('message-1')).toBe(true)
  })

  it('revalidates before touching the server', async () => {
    const { calls, send } = fixture(1)
    await expect(
      send('do work', async () => {
        throw new Error('lease changed')
      })
    ).rejects.toThrow('lease changed')
    expect(calls).toHaveLength(0)
  })
})
