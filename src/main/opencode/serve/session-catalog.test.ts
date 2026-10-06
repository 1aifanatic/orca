import { describe, expect, it, vi } from 'vitest'
import { OpenCodeHttpPeer } from './http-peer'
import { OpenCodeSessionClient } from './session-client'

function catalogClient(major: 1 | 2, fetchImpl: typeof fetch) {
  return new OpenCodeSessionClient(
    new OpenCodeHttpPeer({ port: 48716, password: 'fixture', fetch: fetchImpl }),
    { major, version: major === 1 ? '1.18.31' : '2.0.14' },
    '/project'
  )
}

describe('OpenCode native options', () => {
  it('leaves the 1.x configured default unconfirmed until the provider reports it', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname
      return Response.json(
        path === '/config/providers'
          ? {
              providers: [
                {
                  id: 'provider',
                  models: {
                    model: {
                      id: 'model',
                      name: 'Model',
                      variants: { low: {} },
                      limit: { context: 100_000 }
                    }
                  }
                }
              ]
            }
          : path === '/agent'
            ? [
                { name: 'build', mode: 'primary' },
                { name: 'plan', mode: 'primary' },
                { name: 'explore', mode: 'subagent' }
              ]
            : path === '/command'
              ? [{ name: 'review', description: 'Review' }]
              : { id: 'root' }
      )
    })
    const client = catalogClient(1, fetchImpl)
    const catalog = await client.readCatalog('root')
    expect(catalog.current).toEqual({ model: 'default', confirmed: [] })
    expect(catalog.modes.map((mode) => mode.value)).toEqual(['build', 'plan'])
    expect(catalog.models[0]?.contextWindowTokens).toBe(100_000)
    expect(catalog.models.some((model) => model.isDefault)).toBe(false)
    client.peer.close()
  })

  it('changes a 2.x model without carrying an unsupported old variant and confirms native defaults', async () => {
    const nativeModel: { providerID: string; id: string; variant?: string } = {
      providerID: 'provider',
      id: 'old',
      variant: 'high'
    }
    const fetchImpl = vi.fn<typeof fetch>(async (url, options) => {
      const path = new URL(String(url)).pathname
      if (options?.method === 'POST') {
        const body = JSON.parse(String(options.body))
        nativeModel.id = body.model.id
        delete nativeModel.variant
        return new Response(null, { status: 204 })
      }
      return Response.json(
        path === '/api/model'
          ? {
              data: [
                { id: 'old', providerID: 'provider', variants: [{ id: 'high' }] },
                { id: 'new', providerID: 'provider', variants: [{ id: 'low' }] }
              ]
            }
          : path === '/api/agent'
            ? { data: [{ id: 'build', name: 'Build', mode: 'primary' }] }
            : path === '/api/command'
              ? { data: [] }
              : { data: { id: 'root', agent: 'build', model: nativeModel } }
      )
    })
    const client = catalogClient(2, fetchImpl)
    await expect(
      client.setOption('root', 'model', 'provider/new', { model: 'provider/old', effort: 'high' })
    ).resolves.toEqual({ model: 'provider/new', effort: 'default' })
    const mutation = fetchImpl.mock.calls.find(([, options]) => options?.method === 'POST')
    expect(mutation?.[1]?.body).toBe('{"model":{"providerID":"provider","id":"new"}}')
    expect(
      fetchImpl.mock.calls.every(([url]) => {
        const parsed = new URL(String(url))
        return (
          parsed.pathname.includes('/session/') ||
          parsed.searchParams.get('location[directory]') === '/project'
        )
      })
    ).toBe(true)
    client.peer.close()
  })
})
