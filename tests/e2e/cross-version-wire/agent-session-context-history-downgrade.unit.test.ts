import { expect, test } from 'vitest'
import {
  materializeReleaseCheckout,
  importReleaseCheckoutModule,
  resolveBaselineReleaseRef
} from './release-checkout'
import {
  historicalStore,
  historicalRecord,
  historicalHandle
} from './agent-session-historical-store.test-fixture'
import { providerContextRecordFixture } from '../../../src/shared/agent-session-provider-context.test-fixture'
import {
  encodeAgentSessionRecord,
  decodePersistedAgentSessionRecord
} from '../../../src/shared/agent-session-record-stored-form'
import { isPersistedAgentSessionRecord } from '../../../src/shared/agent-session-record'
import { agentSessionProviderClaims } from '../../../src/shared/agent-session-provider-claims'

const BASE_REF = '8ae5264c638'
const LEGACY_REFS = ['v1.4.222', BASE_REF]
// HEAD exercises the archive-aware path before the rolling stable release contains it.
const REFS = [...new Set([...LEGACY_REFS, resolveBaselineReleaseRef(), 'HEAD'])]
const CASES = REFS.flatMap((ref) =>
  (['claude', 'codex'] as const).map((provider) => ({ ref, provider }))
)

test.each(REFS)(
  '%s updates the visible Claude resume point without erasing the archive',
  async (ref) => {
    const checkout = await materializeReleaseCheckout(ref)
    const store = await historicalStore(checkout)
    try {
      const record = providerContextRecordFixture('claude')
      store.insert(record.sessionId, encodeAgentSessionRecord(record))
      const loaded = store.load()
      const draft = store.draft(loaded)
      const old = historicalRecord(draft.records.get(record.sessionId))
      const transition = await importReleaseCheckoutModule(
        checkout,
        'src/main/runtime/agent-session-provider-handle-transition.ts'
      )
      const revise =
        transition.reviseAgentSessionProviderResumePoint ??
        transition.reviseAgentSessionClaudeResumePoint
      if (typeof revise !== 'function') {
        throw new Error('historical build must expose its actual resume-point transition')
      }
      const handle = historicalHandle(
        'claude',
        'context-1',
        'transport' in old.providerHandleChain[0].handle
      )
      const changed = revise({
        record: { ...old, lease: { ...old.lease, unreconciled: false } },
        fence: 3,
        handle: { ...handle, resumeCursor: 'updated-leaf' },
        providerSessionId: 'context-1',
        leafUuid: 'updated-leaf',
        now: 4000
      })
      draft.records.set(record.sessionId, changed)
      store.write(loaded, draft)
      const written = store.read(record.sessionId)
      if (!isPersistedAgentSessionRecord(written)) {
        throw new Error('historical resume point must remain readable on upgrade')
      }
      const upgraded = decodePersistedAgentSessionRecord(written).record
      expect(upgraded.providerHandleChain.slice(0, 2)).toEqual(
        record.providerHandleChain.slice(0, 2)
      )
      expect(upgraded.providerHandleChain[2].replaces).toEqual(
        record.providerHandleChain[2].replaces
      )
      expect(upgraded.providerHandleChain[2].handle.resumeCursor).toBe('updated-leaf')
    } finally {
      store.db.close()
    }
  },
  300_000
)

test.each(CASES)(
  '$ref reads and writes $provider replacements without losing provenance',
  async ({ ref, provider }) => {
    const checkout = await materializeReleaseCheckout(ref)
    const store = await historicalStore(checkout)
    try {
      const record = providerContextRecordFixture(provider, [2, 2, 1])
      const stored = encodeAgentSessionRecord(record)
      store.insert(record.sessionId, stored)
      const loaded = store.load()
      expect(loaded.unreadableRecords.size).toBe(0)
      const old = historicalRecord(loaded.records.get(record.sessionId))
      if (LEGACY_REFS.includes(ref)) {
        expect(store.readsContextHistory).toBe(false)
      }
      if (ref === 'HEAD') {
        expect(store.readsContextHistory).toBe(true)
      }
      expect(old.providerHandleChain).toHaveLength(
        store.readsContextHistory ? record.providerHandleChain.length : 1
      )
      const draft = store.draft(loaded)
      draft.records.set(record.sessionId, { ...old, lease: { ...old.lease, unreconciled: false } })
      store.write(loaded, draft)
      const rewritten = store.read(record.sessionId)
      expect(rewritten).toEqual(stored)
      if (!isPersistedAgentSessionRecord(rewritten)) {
        throw new Error('upgraded record must remain readable')
      }
      expect(decodePersistedAgentSessionRecord(rewritten).record).toEqual(record)
    } finally {
      store.db.close()
    }
  },
  300_000
)

test.each(CASES)(
  '$ref grows the visible $provider chain to 256 beside 256 archived links',
  async ({ ref, provider }) => {
    const store = await historicalStore(await materializeReleaseCheckout(ref))
    try {
      const record = providerContextRecordFixture(provider, [256, 1])
      store.insert(record.sessionId, encodeAgentSessionRecord(record))
      const loaded = store.load()
      const draft = store.draft(loaded)
      const old = historicalRecord(draft.records.get(record.sessionId))
      let chain = old.providerHandleChain
      const head = chain.at(-1)
      for (let fence = 258; fence <= 512; fence += 1) {
        chain = store.appendLink(chain, {
          linkId: `old-${fence}`,
          handle: head.handle,
          origin: 'resumed',
          mintedAtFence: fence,
          observedAt: fence * 1000
        })
      }
      draft.records.set(record.sessionId, {
        ...old,
        providerHandleChain: chain,
        lease: {
          ...old.lease,
          runtimeFence: 512,
          provenHandleLinkId: 'old-512',
          unreconciled: false
        }
      })
      store.write(loaded, draft)
      const written = store.read(record.sessionId)
      if (!isPersistedAgentSessionRecord(written)) {
        throw new Error('independent 256-link contexts must read back')
      }
      const upgraded = decodePersistedAgentSessionRecord(written).record
      expect(upgraded.providerHandleChain).toHaveLength(512)
      expect(upgraded.providerHandleChain[256].replaces).toEqual(
        record.providerHandleChain[256].replaces
      )
      expect(upgraded.providerHandleChain.at(-1)?.linkId).toBe('old-512')
    } finally {
      store.db.close()
    }
  },
  300_000
)

test.each(CASES)(
  '$ref $provider unsaved supersession and subsequent fork preserve the archive',
  async ({ ref, provider }) => {
    const store = await historicalStore(await materializeReleaseCheckout(ref))
    try {
      const record = providerContextRecordFixture(provider)
      store.insert(record.sessionId, encodeAgentSessionRecord(record))
      const loaded = store.load()
      const draft = store.draft(loaded)
      const old = historicalRecord(draft.records.get(record.sessionId))
      const head = old.providerHandleChain.at(-1)
      const neutral = 'transport' in head.handle
      const superseding = {
        linkId: 'old-superseding',
        origin: 'created',
        mintedAtFence: 4,
        observedAt: 4000,
        handle: historicalHandle(provider, 'third-context', neutral),
        supersedesKey: store.key(head.handle)
      }
      const superseded = store.appendLink(old.providerHandleChain, superseding)
      const forked = store.appendLink(superseded, {
        linkId: 'old-fork',
        origin: 'forked',
        mintedAtFence: 5,
        observedAt: 5000,
        handle: historicalHandle(provider, 'fork-context', neutral),
        forkedFromKey: store.key(superseding.handle)
      })
      draft.records.set(record.sessionId, {
        ...old,
        providerHandleChain: forked,
        lease: {
          ...old.lease,
          runtimeFence: 5,
          provenHandleLinkId: 'old-fork',
          unreconciled: false
        }
      })
      store.write(loaded, draft)
      const written = store.read(record.sessionId)
      if (!isPersistedAgentSessionRecord(written)) {
        throw new Error('supersession and fork must read back')
      }
      const upgraded = decodePersistedAgentSessionRecord(written).record
      expect(upgraded.providerHandleChain.map((link) => link.linkId)).toEqual([
        'link-1',
        'link-2',
        'old-superseding',
        'old-fork'
      ])
      expect(upgraded.providerHandleChain[2].replaces).toEqual(
        record.providerHandleChain[2].replaces
      )
    } finally {
      store.db.close()
    }
  },
  300_000
)

test.each(CASES)(
  '$ref applies its $provider archive ownership policy before re-upgrade',
  async ({ ref, provider }) => {
    const checkout = await materializeReleaseCheckout(ref)
    const store = await historicalStore(checkout)
    try {
      const original = providerContextRecordFixture(provider)
      const stored = encodeAgentSessionRecord(original)
      store.insert(original.sessionId, stored)
      const loaded = store.load()
      const draft = store.draft(loaded)
      const oldRecord = historicalRecord(draft.records.get(original.sessionId))
      const neutral = 'transport' in oldRecord.providerHandleChain[0].handle
      const admission = await importReleaseCheckoutModule(
        checkout,
        'src/main/runtime/agent-session-reservation-admission.ts'
      )
      const commit = admission.commitAgentSessionReservation
      if (typeof commit !== 'function') {
        throw new Error('old adoption must use its actual reservation admission')
      }
      const adopt = () =>
        commit(
          draft,
          {
            sessionId: 'old-adopted',
            location: original.location,
            provider,
            accountHome: original.accountHome,
            adoptedHandleLink: {
              linkId: 'adopted-1',
              handle: historicalHandle(provider, 'context-0', neutral),
              origin: 'adopted',
              mintedAtFence: 1,
              observedAt: 1000
            },
            expectedFence: null,
            spawnToken: 'old-token',
            claimKeyId: 'old-key',
            handoffOperationId: null,
            probe: { outcome: 'reservation-unused' },
            operation: {
              callerKey: 'caller',
              operationId: '1800000000000-0123456789abcdef0123456789abcdef',
              fingerprint: 'old-adoption'
            },
            now: 1800000000000
          },
          30_000
        )
      if (store.readsContextHistory) {
        expect(adopt).toThrowError('agent_session_conflict')
        expect(draft.records.has('old-adopted')).toBe(false)
        expect(store.read(original.sessionId)).toEqual(stored)
        return
      }
      adopt()
      store.write(loaded, draft)
      const upgraded = [original.sessionId, 'old-adopted'].map((id) => {
        const row = store.read(id)
        if (!isPersistedAgentSessionRecord(row)) {
          throw new Error('both upgraded chats must read')
        }
        return decodePersistedAgentSessionRecord(row).record
      })
      for (const order of [upgraded, upgraded.toReversed()]) {
        const claims = agentSessionProviderClaims(order)
        expect(
          claims
            .filter((claim) => claim.handle.nativeId === 'context-0')
            .map((claim) => claim.record.sessionId)
        ).toEqual(['old-adopted'])
        expect(
          claims.find((claim) => claim.handle.nativeId === 'context-1')?.record.sessionId
        ).toBe(original.sessionId)
      }
    } finally {
      store.db.close()
    }
  },
  300_000
)
