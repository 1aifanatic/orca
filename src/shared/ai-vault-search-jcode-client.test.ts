import { describe, expect, it, vi } from 'vitest'
import { createSessionSearchClient, unavailableSessionSearchStatus } from './ai-vault-search-client'
import { AiVaultSearchRequestSchema as LegacyRequestSchema } from './__fixtures__/pre-qoder-search-request'
import { AI_VAULT_AGENTS } from './ai-vault-types'
import { searchHit, searchResults } from './ai-vault-search-test-fixture'

describe('Jcode search negotiation', () => {
  it.each(['runtime', 'relay'] as const)(
    'refuses sole Jcode before the closed legacy request parser over %s',
    async (transport) => {
      const search = vi.fn((request: unknown) => {
        LegacyRequestSchema.parse(request)
        return searchResults()
      })
      const status = vi.fn(() => unavailableSessionSearchStatus())
      const client = createSessionSearchClient(
        async (method, request) => (method === 'aiVault.searchStatus' ? status() : search(request)),
        transport
      )
      expect(
        await client.searchSessions({ query: 'needle', filters: { agents: ['jcode'] } })
      ).toEqual({ kind: 'unavailable', reason: 'unsupported-agent' })
      expect(status).toHaveBeenCalledTimes(1)
      expect(search).not.toHaveBeenCalled()
    }
  )

  it.each(['runtime', 'relay'] as const)(
    'narrows both new agents with one probe and preserves every query field over %s',
    async (transport) => {
      const request = {
        query: 'needle',
        scope: 'conversation' as const,
        freshness: 'indexed' as const,
        limit: 13,
        cursor: 'held-page',
        debug: true,
        within: { kind: 'workspace' as const, worktreeId: 'folder:/task-owned/folder' },
        filters: {
          agents: ['jcode', 'qoder', 'codex', 'claude'] as const,
          since: '2026-08-01T00:00:00Z',
          sort: 'newest' as const
        }
      }
      const call = vi.fn(async (method: string, params: unknown) => {
        if (method === 'aiVault.searchStatus') {
          return unavailableSessionSearchStatus()
        }
        expect(LegacyRequestSchema.parse(params)).toEqual({
          ...request,
          filters: { ...request.filters, agents: ['codex', 'claude'] }
        })
        return searchResults()
      })
      await createSessionSearchClient(call, transport).searchSessions({
        ...request,
        filters: { ...request.filters, agents: [...request.filters.agents] }
      })
      expect(call.mock.calls.map(([method]) => method)).toEqual([
        'aiVault.searchStatus',
        'aiVault.searchSessions'
      ])
    }
  )

  it.each(['runtime', 'relay'] as const)(
    'keeps supported Jcode identity and negotiates Qoder independently over %s',
    async (transport) => {
      const call = vi.fn(async (method: string) =>
        method === 'aiVault.searchStatus'
          ? { ...unavailableSessionSearchStatus(), supportsJcodeHistory: true }
          : { ...searchResults(), hits: [{ ...searchHit(), agent: 'jcode' as const }] }
      )
      const response = await createSessionSearchClient(call, transport).searchSessions({
        query: 'needle',
        filters: { agents: ['qoder', 'jcode'] }
      })
      expect(response).toMatchObject({ kind: 'results', hits: [{ agent: 'jcode' }] })
      expect(call).toHaveBeenLastCalledWith('aiVault.searchSessions', {
        query: 'needle',
        limit: 20,
        filters: { agents: ['jcode'] },
        supportsQoderHistory: true,
        supportsJcodeHistory: true
      })
      expect(call).toHaveBeenCalledTimes(2)
    }
  )

  it('preserves the existing positive Qoder capability when Jcode is unsupported', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'aiVault.searchStatus'
        ? {
            ...unavailableSessionSearchStatus(),
            supportsQoderHistory: true,
            supportsJcodeHistory: false
          }
        : { ...searchResults(), hits: [{ ...searchHit(), agent: 'qoder' as const }] }
    )
    expect(
      await createSessionSearchClient(call, 'relay').searchSessions({
        query: 'needle',
        filters: { agents: ['jcode', 'qoder'] }
      })
    ).toMatchObject({ hits: [{ agent: 'qoder' }] })
    expect(call).toHaveBeenLastCalledWith(
      'aiVault.searchSessions',
      expect.objectContaining({
        filters: { agents: ['qoder'] }
      })
    )
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('passes every legacy agent through the closed parser in an all-agent request', async () => {
    const call = vi.fn(async (method: string, request: unknown) => {
      if (method === 'aiVault.searchStatus') {
        return unavailableSessionSearchStatus()
      }
      expect(LegacyRequestSchema.parse(request)).toMatchObject({
        filters: {
          agents: AI_VAULT_AGENTS.filter((agent) => agent !== 'qoder' && agent !== 'jcode')
        }
      })
      return searchResults()
    })
    await createSessionSearchClient(call, 'relay').searchSessions({
      query: 'needle',
      filters: { agents: [...AI_VAULT_AGENTS] }
    })
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('leaves IPC and its per-host merge in charge of the current catalog', async () => {
    const call = vi.fn(async () => ({
      ...searchResults(),
      hits: [{ ...searchHit(), agent: 'jcode' as const }]
    }))
    expect(
      await createSessionSearchClient(call, 'ipc').searchSessions({
        query: 'needle',
        filters: { agents: ['jcode', 'qoder'] }
      })
    ).toMatchObject({ hits: [{ agent: 'jcode' }] })
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchSessions', {
      query: 'needle',
      limit: 20,
      filters: { agents: ['jcode', 'qoder'] },
      supportsQoderHistory: true,
      supportsJcodeHistory: true
    })
  })

  it.each([
    ['contact loss', new Error('host disconnected'), undefined],
    ['scope refusal', Object.assign(new Error('forbidden'), { code: 'forbidden' }), undefined],
    ['unknown method', Object.assign(new Error('unknown method'), { code: -32601 }), 'no-service']
  ] as const)('keeps %s distinct during the Jcode probe', async (_name, error, reason) => {
    const call = vi.fn(async () => {
      throw error
    })
    const result = createSessionSearchClient(call, 'relay').searchSessions({
      query: 'needle',
      filters: { agents: ['jcode'] }
    })
    if (reason) {
      expect(await result).toEqual({ kind: 'unavailable', reason })
    } else {
      await expect(result).rejects.toBe(error)
    }
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchStatus', {})
  })
})
