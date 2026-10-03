import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { AiVaultHandler } from './ai-vault-handler'
import { SshChannelMultiplexer } from '../main/ssh/ssh-channel-multiplexer'
import { createSessionSearchClient } from '../shared/ai-vault-search-client'
import { AI_VAULT_AGENTS } from '../shared/ai-vault-types'
import { fakeSearchService, searchHit, searchResults } from '../shared/ai-vault-search-test-fixture'
import { setSessionSearchService } from '../main/ai-vault-search/session-search-service-registry'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((close) => close())
  setSessionSearchService(null)
})

function wire(register: boolean) {
  let receive!: (data: Buffer) => void
  const host = new RelayDispatcher((data) => receive(Buffer.from(data)))
  const mux = new SshChannelMultiplexer({
    write: (data) => host.feed(data),
    onData: (callback) => {
      receive = callback
    },
    onClose: () => {}
  })
  cleanups.push(() => {
    mux.dispose()
    host.dispose()
  })
  if (register) {
    new AiVaultHandler(host, { remoteHome: '/synthetic-host' })
  }
  const client = createSessionSearchClient((method, params) => mux.request(method, params), 'relay')
  return { host, mux, client }
}

describe('session search over real relay frames', () => {
  it('parses on the host and client and withholds host paths on the wire', async () => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    const { client, mux } = wire(true)
    const result = await client.searchSessions({ query: 'needle' })
    expect(result).toMatchObject({
      kind: 'results',
      hits: [{ sessionId: 'host-session', source: { presence: 'present' } }]
    })
    const raw = await mux.request('aiVault.searchSessions', {
      query: 'needle',
      tier: 'conversation',
      refresh: true
    })
    expect(raw).toMatchObject({ hits: [{ source: { presence: 'present' } }] })
    expect(JSON.stringify(raw)).not.toContain('/host/transcript')
    expect(JSON.stringify(raw)).not.toContain('/host/codex')
    expect(JSON.stringify(raw)).not.toContain('resumeCommand')
    expect(service.search).toHaveBeenLastCalledWith(
      {
        query: 'needle',
        limit: 20,
        filters: {
          agents: AI_VAULT_AGENTS.filter((agent) => agent !== 'qoder' && agent !== 'jcode')
        }
      },
      undefined
    )
    expect(service.reconcile).not.toHaveBeenCalled()
    expect(await client.searchStatus()).toMatchObject({ enabled: true, generation: 7 })
    await expect(mux.request('aiVault.searchSessions', { query: 42 })).rejects.toThrow()
    expect(service.search).toHaveBeenCalledTimes(2)
  })
  it('maps a real old-host unknown-method response to unavailable without invoking a local service', async () => {
    const local = fakeSearchService()
    setSessionSearchService(local)
    const { client } = wire(false)
    expect(await client.searchSessions({ query: 'needle' })).toEqual({
      kind: 'unavailable',
      reason: 'no-service'
    })
    expect(await client.searchStatus()).toMatchObject({ enabled: false, generation: 0 })
    expect(local.search).not.toHaveBeenCalled()
  })
  it('registers the endpoints without a scanner service or production index', async () => {
    const { client } = wire(true)
    expect(await client.searchSessions({ query: 'needle' })).toEqual({
      kind: 'unavailable',
      reason: 'no-service'
    })
  })
  it('propagates transport loss rather than substituting local results', async () => {
    const local = fakeSearchService()
    setSessionSearchService(local)
    const { client, mux } = wire(true)
    mux.dispose()
    await expect(client.searchSessions({ query: 'needle' })).rejects.toThrow()
    expect(local.search).not.toHaveBeenCalled()
  })
})

it('negotiates current Jcode through the real SSH relay frames', async () => {
  const service = fakeSearchService()
  service.search.mockResolvedValue({
    ...searchResults(),
    hits: [{ ...searchHit(), agent: 'jcode' }]
  })
  setSessionSearchService(service)
  const { client, mux } = wire(true)
  const call = vi.spyOn(mux, 'request')
  const result = await client.searchSessions({ query: 'needle', filters: { agents: ['jcode'] } })
  expect(result).toMatchObject({ hits: [{ agent: 'jcode', source: { presence: 'present' } }] })
  expect(JSON.stringify(result)).not.toContain('/host/transcript.jsonl')
  expect(call.mock.calls.map(([method]) => method)).toEqual([
    'aiVault.searchStatus',
    'aiVault.searchSessions'
  ])
  expect(service.search).toHaveBeenCalledExactlyOnceWith(
    {
      query: 'needle',
      limit: 20,
      filters: { agents: ['jcode'] }
    },
    undefined
  )
})
