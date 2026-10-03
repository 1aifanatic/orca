import { afterEach, expect, it } from 'vitest'
import {
  fakeSearchService,
  searchHit,
  searchResults
} from '../../shared/ai-vault-search-test-fixture'
import { createSessionSearchClient } from '../../shared/ai-vault-search-client'
import {
  setSessionSearchService,
  searchSessionService,
  sessionSearchServiceStatus
} from './session-search-service-registry'

afterEach(() => setSessionSearchService(null))

it.each(['ipc', 'runtime', 'relay'] as const)(
  'negotiates Jcode before retrieval on %s while preserving consent and empty-page semantics',
  async (transport) => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    expect(await sessionSearchServiceStatus({}, transport)).toMatchObject({
      supportsJcodeHistory: true,
      supportsQoderHistory: true
    })
    expect(
      await searchSessionService(
        {
          query: 'needle',
          filters: { agents: ['jcode'] }
        },
        transport
      )
    ).toMatchObject({ kind: 'results', hits: [], page: { cursor: null, hasMore: false } })
    expect(service.search.mock.calls[0]?.[0].filters?.agents).not.toContain('jcode')
    for (const reason of ['disabled', 'not-ready'] as const) {
      service.search.mockResolvedValue({ kind: 'unavailable', reason })
      expect(
        await searchSessionService(
          {
            query: 'needle',
            filters: { agents: ['jcode'] }
          },
          transport
        )
      ).toEqual({ kind: 'unavailable', reason })
    }
    service.search.mockResolvedValue({
      ...searchResults(),
      hits: [{ ...searchHit(), agent: 'jcode' }]
    })
    const client = createSessionSearchClient(
      (method, request) =>
        method === 'aiVault.searchStatus'
          ? sessionSearchServiceStatus(request, transport)
          : searchSessionService(request, transport),
      transport
    )
    expect(
      await client.searchSessions({ query: 'needle', filters: { agents: ['jcode'] } })
    ).toMatchObject({ hits: [{ agent: 'jcode' }] })
    expect(service.search).toHaveBeenLastCalledWith(
      {
        query: 'needle',
        limit: 20,
        filters: { agents: ['jcode'] }
      },
      undefined
    )
  }
)
