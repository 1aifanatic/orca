import { describe, expect, it } from 'vitest'
import {
  appendAgentSessionProviderHandleLink,
  isAgentSessionProviderHandleChain
} from './agent-session-provider-handle'
import {
  codexProviderHandle,
  agentSessionProviderHandleKey
} from './agent-session-provider-handle-encoding'
import { decodeProviderContextHistory } from './agent-session-provider-context-history'
import { providerContextRecordFixture } from './agent-session-provider-context.test-fixture'
import {
  decodePersistedAgentSessionRecord,
  encodeAgentSessionRecord
} from './agent-session-record-stored-form'
import { isPersistedAgentSessionRecord } from './agent-session-record'

describe.each(['claude', 'codex'] as const)('%s retained provider contexts', (provider) => {
  it('stores disjoint segments and restores truthful creation reasons', () => {
    const record = providerContextRecordFixture(provider, [2, 2, 3])
    const stored = encodeAgentSessionRecord(record)
    expect(stored.providerHandleChain).toHaveLength(3)
    expect(stored.providerHandleChain[0].replaces).toBeUndefined()
    expect(stored.providerContextHistory?.links).toHaveLength(4)
    expect(isPersistedAgentSessionRecord(stored)).toBe(true)
    const decoded = decodePersistedAgentSessionRecord(stored).record
    expect(decoded).toEqual(record)
    expect(decoded).not.toHaveProperty('providerContextHistory')
    expect(encodeAgentSessionRecord(decoded)).toEqual(stored)
  })

  it('accepts independently full archived and visible contexts', () => {
    const record = providerContextRecordFixture(provider, [256, 256])
    const stored = encodeAgentSessionRecord(record)
    expect(stored.providerHandleChain).toHaveLength(256)
    expect(stored.providerContextHistory?.links).toHaveLength(256)
    expect(isPersistedAgentSessionRecord(stored)).toBe(true)
    expect(decodePersistedAgentSessionRecord(stored).record).toEqual(record)
    expect(
      isAgentSessionProviderHandleChain(
        providerContextRecordFixture(provider, [257, 1]).providerHandleChain
      )
    ).toBe(false)
    expect(() =>
      appendAgentSessionProviderHandleLink(record.providerHandleChain, {
        ...record.providerHandleChain[511],
        linkId: 'overflow',
        mintedAtFence: 513
      })
    ).toThrow('agent_session_provider_handle_chain_overflow')
  })

  it('rejects malformed archives and disagreement across the seam', () => {
    const stored = encodeAgentSessionRecord(providerContextRecordFixture(provider))
    const history = stored.providerContextHistory
    if (!history) {
      throw new Error('fixture must archive its earlier context')
    }
    for (const corrupt of [
      null,
      { ...history, version: 2 },
      { ...history, links: [] },
      { ...history, links: [{ version: 1, links: history.links }] },
      { ...history, replacement: { ...history.replacement, key: 'codex:"elsewhere"' } },
      { ...history, replacement: { ...history.replacement, reason: '' } },
      { ...history, links: [...history.links, history.links[0]] }
    ]) {
      const malformed = { ...stored, providerContextHistory: corrupt }
      expect(isPersistedAgentSessionRecord(malformed)).toBe(false)
      expect(decodeProviderContextHistory(stored.providerHandleChain, corrupt)).toBeNull()
    }
    expect(isPersistedAgentSessionRecord({ ...stored, providerHandleChain: [] })).toBe(false)
    const first = stored.providerHandleChain[0]
    expect(
      isPersistedAgentSessionRecord({
        ...stored,
        providerHandleChain: [{ ...first, linkId: history.links[0].linkId }]
      })
    ).toBe(false)
    expect(
      isPersistedAgentSessionRecord({
        ...stored,
        providerHandleChain: [{ ...first, mintedAtFence: 0 }]
      })
    ).toBe(false)
  })
})

it('retains the replaced conversation when the fresh unsaved creation is superseded', () => {
  const record = providerContextRecordFixture('codex')
  const head = record.providerHandleChain.at(-1)
  if (!head) {
    throw new Error('fixture must have a head')
  }
  const chain = appendAgentSessionProviderHandleLink(record.providerHandleChain, {
    linkId: 'superseding',
    handle: codexProviderHandle('third-context'),
    origin: 'created',
    mintedAtFence: 4,
    observedAt: 4000,
    supersedesKey: agentSessionProviderHandleKey(head.handle)
  })
  expect(chain.at(-1)?.replaces).toEqual(head.replaces)
  expect(isAgentSessionProviderHandleChain(chain)).toBe(true)
  const next = {
    ...record,
    providerHandleChain: chain,
    lease: { ...record.lease, runtimeFence: 4, provenHandleLinkId: 'superseding' }
  }
  expect(decodePersistedAgentSessionRecord(encodeAgentSessionRecord(next)).record).toEqual(next)
})
