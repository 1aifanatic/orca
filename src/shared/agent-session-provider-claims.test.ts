import { expect, it } from 'vitest'
import { agentSessionProviderClaims } from './agent-session-provider-claims'
import { providerContextRecordFixture } from './agent-session-provider-context.test-fixture'

it('keeps archives as reservations and prefers the visible owner regardless of record order', () => {
  const original = providerContextRecordFixture('codex')
  const adopted = { ...providerContextRecordFixture('codex', [1]), sessionId: 'adopted-chat' }
  for (const records of [
    [original, adopted],
    [adopted, original]
  ]) {
    expect(
      agentSessionProviderClaims(records).filter((claim) => claim.handle.nativeId === 'context-0')
    ).toEqual([{ record: adopted, handle: adopted.providerHandleChain[0].handle, archived: false }])
  }
  expect(
    agentSessionProviderClaims([original]).find((claim) => claim.handle.nativeId === 'context-0')
      ?.archived
  ).toBe(true)
})

it('does not hide conflicting visible claims, and picks a stable archive-only display owner', () => {
  const first = { ...providerContextRecordFixture('codex'), sessionId: 'a-chat' }
  const second = { ...providerContextRecordFixture('codex'), sessionId: 'z-chat' }
  for (const records of [
    [first, second],
    [second, first]
  ]) {
    const claims = agentSessionProviderClaims(records)
    expect(claims.filter((claim) => claim.handle.nativeId === 'context-1')).toHaveLength(2)
    expect(claims.find((claim) => claim.handle.nativeId === 'context-0')?.record.sessionId).toBe(
      'a-chat'
    )
  }
})
