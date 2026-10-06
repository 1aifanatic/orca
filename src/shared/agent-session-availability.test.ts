import { describe, expect, it } from 'vitest'
import {
  readAgentSessionAvailability,
  claudeInitializationSignedOut,
  agentSessionSignInCopyId
} from './agent-session-availability'
import { agentSessionFailureSentence } from './agent-session-failure-words'
import { AGENT_SESSION_FAILURE_COPY } from './agent-session-failure-copy'

describe('positive agent availability evidence', () => {
  it.each([
    undefined,
    null,
    {},
    { state: 'future', recheckInMs: 100 },
    { state: 'cliMissing', recheckInMs: 0 },
    { state: 'cliMissing', recheckInMs: Infinity },
    { state: 'cliMissing', recheckInMs: '10' },
    { state: 'cliMissing' },
    { state: 'notSignedIn', account: 'future', recheckInMs: 100 }
  ])('ignores unknown or malformed answers %j', (value) => {
    expect(readAgentSessionAvailability(value)).toBeNull()
  })
  it('reads a ready account, which needs no re-read hint', () => {
    expect(readAgentSessionAvailability({ state: 'ready' })).toEqual({ state: 'ready' })
  })
  it.each(['managed', 'system'] as const)('retains %s account context', (account) => {
    expect(
      readAgentSessionAvailability({ state: 'notSignedIn', account, recheckInMs: 50 })
    ).toEqual({ state: 'notSignedIn', account, recheckInMs: 50 })
  })
  it("clamps a longer host hint to this client's hold instead of dropping it", () => {
    expect(readAgentSessionAvailability({ state: 'cliMissing', recheckInMs: 900_000 })).toEqual({
      state: 'cliMissing',
      recheckInMs: 300_000
    })
  })
  it('retains signed-out evidence without optional account context', () => {
    expect(readAgentSessionAvailability({ state: 'notSignedIn', recheckInMs: 50 })).toEqual({
      state: 'notSignedIn',
      recheckInMs: 50
    })
  })
  it.each([
    null,
    {},
    { account: null },
    { account: { tokenSource: 'oauth' } },
    { account: { tokenSource: true } }
  ])('unknown Claude initialization is not signed out %j', (value) => {
    expect(claudeInitializationSignedOut(value)).toBe(false)
  })
  it('accepts only the explicit Claude token source none', () => {
    expect(claudeInitializationSignedOut({ account: { tokenSource: 'none' } })).toBe(true)
  })
  it('an API key source is a sign-in beside tokenSource none', () => {
    expect(
      claudeInitializationSignedOut({
        account: { tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY' }
      })
    ).toBe(false)
    expect(
      claudeInitializationSignedOut({ account: { tokenSource: 'none', apiKeySource: 'none' } })
    ).toBe(true)
  })
  it.each([
    ['claude', 'system', 'claudeSystemNotSignedIn'],
    ['claude', 'managed', 'claudeManagedNotSignedIn'],
    ['claude', undefined, 'claudeSystemNotSignedIn'],
    ['codex', 'system', 'codexSystemNotSignedIn'],
    ['codex', 'managed', 'codexManagedNotSignedIn'],
    ['codex', undefined, 'codexSystemNotSignedIn']
  ] as const)('uses the same %s %s fix after sending', (provider, account, key) => {
    expect(agentSessionSignInCopyId(provider, account)).toBe(key)
    expect(
      agentSessionFailureSentence({ kind: 'notSignedIn', account }, 'rejection', { provider })
    ).toBe(AGENT_SESSION_FAILURE_COPY[key])
  })
})
