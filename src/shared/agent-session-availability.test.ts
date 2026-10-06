import { describe, expect, it } from 'vitest'
import {
  readAgentSessionUnavailable,
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
    { reason: 'future', expiresInMs: 100 },
    { reason: 'cliMissing', expiresInMs: 0 },
    { reason: 'cliMissing', expiresInMs: Infinity },
    { reason: 'cliMissing', expiresInMs: '10' },
    { reason: 'notSignedIn', account: 'future', expiresInMs: 100 }
  ])('ignores unknown or expired evidence %j', (value) => {
    expect(readAgentSessionUnavailable(value)).toBeNull()
  })
  it.each(['managed', 'system'] as const)('retains %s account context', (account) => {
    expect(
      readAgentSessionUnavailable({ reason: 'notSignedIn', account, expiresInMs: 50 })
    ).toEqual({ reason: 'notSignedIn', account, expiresInMs: 50 })
  })
  it("clamps a longer host lifetime to this client's hold instead of dropping it", () => {
    expect(readAgentSessionUnavailable({ reason: 'cliMissing', expiresInMs: 90_000 })).toEqual({
      reason: 'cliMissing',
      expiresInMs: 30_000
    })
  })
  it('retains signed-out evidence without optional account context', () => {
    expect(readAgentSessionUnavailable({ reason: 'notSignedIn', expiresInMs: 50 })).toEqual({
      reason: 'notSignedIn',
      expiresInMs: 50
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
