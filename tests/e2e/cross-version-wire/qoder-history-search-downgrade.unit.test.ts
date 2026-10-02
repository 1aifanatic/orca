import { afterEach, expect, test } from 'vitest'
import { createSessionSearchClient } from '../../../src/shared/ai-vault-search-client'
import { searchResults, fakeSearchService } from '../../../src/shared/ai-vault-search-test-fixture'
import {
  searchSessionService,
  setSessionSearchService
} from '../../../src/main/ai-vault-search/session-search-service-registry'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

afterEach(() => setSessionSearchService(null))

test('a pre-Qoder release can read current host search pages without losing other agents', async () => {
  const checkout = await materializeReleaseCheckout('v1.4.211')
  const baseline = await importReleaseCheckoutModule(
    checkout,
    'src/shared/ai-vault-search-contract.ts'
  )
  const schema = baseline.AiVaultSearchResponseSchema
  if (
    !schema ||
    typeof schema !== 'object' ||
    !('safeParse' in schema) ||
    typeof schema.safeParse !== 'function'
  ) {
    throw new Error('The pinned release has no search response parser')
  }
  const qoder = { ...searchResults().hits[0], agent: 'qoder' as const }
  expect(schema.safeParse({ ...searchResults(), hits: [qoder] })).toHaveProperty('success', false)
  const service = fakeSearchService()
  service.search.mockImplementation(async (request) => ({
    ...searchResults(),
    hits:
      !request.filters?.agents || request.filters.agents.includes('qoder')
        ? [qoder]
        : searchResults().hits
  }))
  setSessionSearchService(service)
  const oldResponse = await searchSessionService({ query: 'proof' }, 'relay')
  expect(schema.safeParse(oldResponse)).toHaveProperty('success', true)
  expect(oldResponse).toMatchObject({ hits: [{ agent: 'codex' }] })
  const client = createSessionSearchClient(
    (_method, request) => searchSessionService(request, 'relay'),
    'relay'
  )
  expect(await client.searchSessions({ query: 'proof' })).toMatchObject({
    hits: [{ agent: 'qoder' }]
  })
  const oldRequest = baseline.AiVaultSearchRequestSchema
  if (
    !oldRequest ||
    typeof oldRequest !== 'object' ||
    !('safeParse' in oldRequest) ||
    typeof oldRequest.safeParse !== 'function'
  ) {
    throw new Error('The pinned release has no search request parser')
  }
  expect(oldRequest.safeParse({ query: 'proof', supportsQoderHistory: true })).toHaveProperty(
    'success',
    true
  )
})
