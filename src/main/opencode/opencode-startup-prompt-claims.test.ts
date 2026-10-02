import { describe, expect, it } from 'vitest'
import type { TerminalRunFacts } from '../runtime/terminal-run-facts'
import { OpenCodeStartupPromptClaims } from './opencode-startup-prompt-claims'

describe('execution-owned startup prompt claims', () => {
  it('consumes each nonce once and checks owner facts at claim time', () => {
    const claims = new OpenCodeStartupPromptClaims()
    let facts: TerminalRunFacts | null = { freshSpawn: true, firstUserInputAt: null }
    claims.register('first', 'hash', () => facts)
    facts.firstUserInputAt = 1
    expect(claims.claim({ nonce: 'first', digest: 'hash' })).toBe(false)
    facts.firstUserInputAt = null
    expect(claims.claim({ nonce: 'first', digest: 'hash' })).toBe(false)
    claims.register('second', 'hash', () => facts)
    expect(claims.claim({ nonce: 'second', digest: 'hash' })).toBe(true)
    expect(claims.claim({ nonce: 'second', digest: 'hash' })).toBe(false)
    claims.register('missing', 'hash', () => facts)
    facts = null
    expect(claims.claim({ nonce: 'missing', digest: 'hash' })).toBe(false)
  })

  it('refuses reattachment, mismatched hashes, expired claims and malformed bodies', () => {
    let now = 0
    const claims = new OpenCodeStartupPromptClaims(() => now)
    claims.register('reattach', 'hash', () => ({ freshSpawn: false, firstUserInputAt: null }))
    expect(claims.claim({ nonce: 'reattach', digest: 'hash' })).toBe(false)
    claims.register('mismatch', 'hash', () => ({ freshSpawn: true, firstUserInputAt: null }))
    expect(claims.claim({ nonce: 'mismatch', digest: 'other' })).toBe(false)
    expect(claims.claim({ nonce: 'mismatch', digest: 'hash' })).toBe(false)
    claims.register('expired', 'hash', () => ({ freshSpawn: true, firstUserInputAt: null }))
    now = 20000
    expect(claims.claim({ nonce: 'expired', digest: 'hash' })).toBe(false)
    for (const body of [null, 1, {}, { nonce: 1 }, { nonce: 'absent' }]) {
      expect(claims.claim(body)).toBe(false)
    }
  })

  it('keeps pending admission bounded and never recreates canceled or consumed claims', () => {
    let now = 0
    const claims = new OpenCodeStartupPromptClaims(() => now)
    claims.register('waiting', 'hash', () => 'pending')
    expect(claims.claim({ nonce: 'waiting', digest: 'hash' })).toBe('pending')
    expect(claims.claim({ nonce: 'waiting', digest: 'hash' })).toBe('pending')
    expect(claims.admit('waiting', () => ({ freshSpawn: true, firstUserInputAt: null }))).toBe(true)
    expect(claims.claim({ nonce: 'waiting', digest: 'hash' })).toBe(true)
    expect(claims.admit('waiting', () => ({ freshSpawn: true, firstUserInputAt: null }))).toBe(
      false
    )
    claims.register('canceled', 'hash', () => 'pending')
    claims.cancel('canceled')
    expect(claims.admit('canceled', () => ({ freshSpawn: true, firstUserInputAt: null }))).toBe(
      false
    )
    claims.register('expired', 'hash', () => 'pending')
    now = 20000
    expect(claims.claim({ nonce: 'expired', digest: 'hash' })).toBe(false)
    expect(claims.admit('expired', () => ({ freshSpawn: true, firstUserInputAt: null }))).toBe(
      false
    )
    claims.clear()
  })

  it('bounds pending claims and reclaims expired capacity without timers', () => {
    let now = 0
    const claims = new OpenCodeStartupPromptClaims(() => now)
    for (let index = 0; index < 129; index++) {
      claims.register(String(index), 'hash', () => ({ freshSpawn: true, firstUserInputAt: null }))
    }
    expect(claims.claim({ nonce: '128', digest: 'hash' })).toBe(false)
    now = 20000
    claims.register('new', 'hash', () => ({ freshSpawn: true, firstUserInputAt: null }))
    expect(claims.claim({ nonce: 'new', digest: 'hash' })).toBe(true)
  })
})
