import { describe, expect, it, vi } from 'vitest'
import { OpenCodeHttpPeer } from './http-peer'
import { OpenCodeSessionClient } from './session-client'

function sessionClient(fetchImpl: typeof fetch) {
  return new OpenCodeSessionClient(
    new OpenCodeHttpPeer({ port: 48715, password: 'fixture', fetch: fetchImpl }),
    { major: 2, version: '2.0.14' },
    '/project'
  )
}

describe('OpenCode forward history cursors', () => {
  it('reads through a short page to explicit empty EOF and never sends order with a cursor', async () => {
    const pages = [
      {
        data: [
          { id: 'one', type: 'user' },
          { id: 'two', type: 'assistant' }
        ],
        cursor: { next: 'opaque-A' }
      },
      { data: [{ id: 'three', type: 'user' }], cursor: { next: 'opaque-B' } },
      { data: [], cursor: { next: null, previous: null } }
    ]
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(pages.shift()))
    const client = sessionClient(fetchImpl)
    await expect(client.history('root')).resolves.toEqual({
      data: [
        { id: 'one', type: 'user' },
        { id: 'two', type: 'assistant' },
        { id: 'three', type: 'user' }
      ],
      cursor: { next: null, previous: null }
    })
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:48715/api/session/root/message?limit=40&order=asc',
      'http://127.0.0.1:48715/api/session/root/message?limit=40&cursor=opaque-A',
      'http://127.0.0.1:48715/api/session/root/message?limit=40&cursor=opaque-B'
    ])
    client.peer.close()
  })

  it('refuses a repeated message instead of appending duplicate restored rows', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ id: 'one' }], cursor: { next: 'opaque-A' } })
    )
    const client = sessionClient(fetchImpl)
    await expect(client.history('root')).rejects.toMatchObject({ kind: 'invalid-response' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    client.peer.close()
  })
})
