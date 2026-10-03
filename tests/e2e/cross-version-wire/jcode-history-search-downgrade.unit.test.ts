import { afterEach, expect, test, vi } from 'vitest'
import {
  createSessionSearchClient,
  unavailableSessionSearchStatus
} from '../../../src/shared/ai-vault-search-client'
import { AI_VAULT_AGENTS } from '../../../src/shared/ai-vault-types'
import { searchResults } from '../../../src/shared/ai-vault-search-test-fixture'
import {
  searchSessionService,
  setSessionSearchService,
  sessionSearchServiceStatus
} from '../../../src/main/ai-vault-search/session-search-service-registry'
import {
  addSyntheticSession,
  openSessionSearchHarness,
  type SessionSearchHarness
} from '../../../src/main/ai-vault-search/session-search-engine-test-fixture'
import { createSessionSearchService } from '../../../src/main/ai-vault-search/session-search-service'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

let harness: SessionSearchHarness | undefined
afterEach(async () => {
  setSessionSearchService(null)
  await harness?.close()
  harness = undefined
})

async function legacy(ref: string) {
  const checkout = await materializeReleaseCheckout(ref)
  const module = await importReleaseCheckoutModule(
    checkout,
    'src/shared/ai-vault-search-contract.ts'
  )
  const request = module.AiVaultSearchRequestSchema
  const response = module.AiVaultSearchResponseSchema
  if (
    !request ||
    typeof request !== 'object' ||
    !('parse' in request) ||
    typeof request.parse !== 'function' ||
    !('safeParse' in request) ||
    typeof request.safeParse !== 'function' ||
    !response ||
    typeof response !== 'object' ||
    !('safeParse' in response) ||
    typeof response.safeParse !== 'function'
  ) {
    throw new Error('Actual pinned release search parsers are missing')
  }
  return { request, response }
}

test.each(['v1.4.211', 'b49abdb1f4da6b3d62dfa9ccf3c74dc9e74d291c'])(
  'current Jcode filters never enter the actual %s closed request enum',
  async (ref) => {
    const { request } = await legacy(ref)
    expect(request.safeParse({ query: 'needle', filters: { agents: ['jcode'] } })).toHaveProperty(
      'success',
      false
    )
    const call = vi.fn(async (method: string, params: unknown) => {
      if (method === 'aiVault.searchStatus') {
        return unavailableSessionSearchStatus()
      }
      request.parse(params)
      return searchResults()
    })
    const client = createSessionSearchClient(call, 'relay')
    expect(
      await client.searchSessions({ query: 'needle', filters: { agents: ['jcode'] } })
    ).toEqual({ kind: 'unavailable', reason: 'unsupported-agent' })
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchStatus', {})
    call.mockClear()
    const within = { kind: 'workspace' as const, worktreeId: 'folder:/task-owned/folder' }
    expect(
      await client.searchSessions({
        query: 'needle',
        within,
        cursor: 'held-cursor',
        debug: true,
        filters: { agents: ['jcode', 'qoder', 'claude', 'codex'], sort: 'newest' }
      })
    ).toMatchObject({ hits: [{ agent: 'codex' }] })
    expect(call).toHaveBeenLastCalledWith('aiVault.searchSessions', {
      query: 'needle',
      limit: 20,
      within,
      cursor: 'held-cursor',
      debug: true,
      filters: { agents: ['claude', 'codex'], sort: 'newest' },
      supportsQoderHistory: true,
      supportsJcodeHistory: true
    })
    expect(call).toHaveBeenCalledTimes(2)
    if (ref.startsWith('b49')) {
      call.mockClear()
      expect(
        await client.searchSessions({
          query: 'needle',
          filters: { agents: [...AI_VAULT_AGENTS] }
        })
      ).toMatchObject({ hits: [{ agent: 'codex' }] })
      expect(call).toHaveBeenLastCalledWith(
        'aiVault.searchSessions',
        expect.objectContaining({
          filters: {
            agents: AI_VAULT_AGENTS.filter((agent) => agent !== 'qoder' && agent !== 'jcode')
          }
        })
      )
      expect(call).toHaveBeenCalledTimes(2)
    }
  }
)

test.each(['relevance', 'newest'] as const)(
  'current host filters Jcode before real SQL candidates, %s ranking and legacy paging',
  async (sort) => {
    harness = await openSessionSearchHarness('jcode-legacy-pages', { sessionCandidateLimit: 2 })
    for (let id = 1; id <= 5; id++) {
      addSyntheticSession(harness.db, {
        id,
        agent: 'jcode',
        text: 'needle',
        updatedAt: '2026-10-03T00:00:00Z'
      })
    }
    addSyntheticSession(harness.db, { id: 6, agent: 'claude', text: 'needle padding' })
    addSyntheticSession(harness.db, { id: 7, agent: 'codex', text: 'needle padding padding' })
    const {
      enabled: _enabled,
      generation: _generation,
      ...status
    } = unavailableSessionSearchStatus()
    setSessionSearchService(
      createSessionSearchService({
        engine: harness.engine,
        indexer: {
          status: () => ({ ...status, messagesIndexed: 0, degradedRoots: [], sessionsByAgent: {} }),
          reconcile: async () => {}
        }
      })
    )
    for (const ref of ['v1.4.211', 'b49abdb1f4da6b3d62dfa9ccf3c74dc9e74d291c']) {
      const { response } = await legacy(ref)
      const seen: string[] = []
      let cursor: string | null = null
      let pages = 0
      do {
        const page = await searchSessionService(
          {
            query: 'needle',
            limit: 1,
            debug: true,
            filters: { sort },
            ...(cursor ? { cursor } : {})
          },
          'relay'
        )
        expect(response.safeParse(page)).toHaveProperty('success', true)
        if (page.kind !== 'results') {
          throw new Error('Expected a legacy result page')
        }
        expect(page.hits).toHaveLength(1)
        expect(page.hits[0]?.agent).not.toBe('jcode')
        expect(page.debug).toBeDefined()
        expect(JSON.stringify(page)).not.toContain('/synthetic/')
        seen.push(...page.hits.map((hit) => hit.sessionId))
        cursor = page.page.cursor
        expect(++pages).toBeLessThan(4)
        expect(page.page.hasMore).toBe(cursor !== null)
      } while (cursor !== null)
      expect(pages).toBe(2)
      expect(seen.sort()).toEqual(['6', '7'])
      expect(new Set(seen).size).toBe(2)
    }
    const call = vi.fn((method: string, params: unknown) =>
      method === 'aiVault.searchStatus'
        ? sessionSearchServiceStatus(params, 'relay')
        : searchSessionService(params, 'relay')
    )
    const current = await createSessionSearchClient(call, 'relay').searchSessions({
      query: 'needle',
      limit: 1,
      filters: { agents: ['jcode'], sort }
    })
    expect(current).toMatchObject({ hits: [{ agent: 'jcode' }], page: { hasMore: true } })
    expect(call).toHaveBeenCalledTimes(2)
    call.mockClear()
    expect(
      await createSessionSearchClient(call, 'relay').searchSessions({
        query: 'needle',
        limit: 1,
        filters: { agents: [...AI_VAULT_AGENTS], sort }
      })
    ).toMatchObject({ hits: [{ agent: 'jcode' }] })
    expect(call).toHaveBeenCalledTimes(2)
    call.mockClear()
    expect(
      await createSessionSearchClient(call, 'relay').searchSessions({
        query: 'needle',
        limit: 1,
        filters: { sort }
      })
    ).toMatchObject({ hits: [{ agent: 'jcode' }] })
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchSessions', {
      query: 'needle',
      limit: 1,
      filters: { sort },
      supportsQoderHistory: true,
      supportsJcodeHistory: true
    })
  }
)
