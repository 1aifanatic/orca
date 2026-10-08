import { expect, it } from 'vitest'
import { providerContextRecordFixture } from '../../../shared/agent-session-provider-context.test-fixture'
import { lookupOrcaAgentSession } from './structured-session-mail-address'

it('corrects a provider id to its visible owner after an older host adopted an archived context', () => {
  const original = providerContextRecordFixture('codex')
  const adopted = { ...providerContextRecordFixture('codex', [1]), sessionId: 'adopted-chat' }
  for (const records of [
    [original, adopted],
    [adopted, original]
  ]) {
    const store = {
      getRecord: (id: string) => records.find((record) => record.sessionId === id) ?? null,
      listRecords: () => records
    }
    expect(lookupOrcaAgentSession(store, 'context-0')).toEqual({
      kind: 'provider-id',
      orcaSessionId: adopted.sessionId
    })
    expect(lookupOrcaAgentSession(store, original.sessionId)).toEqual({
      kind: 'found',
      record: original
    })
    expect(lookupOrcaAgentSession(store, 'missing')).toEqual({ kind: 'unknown' })
  }
})
