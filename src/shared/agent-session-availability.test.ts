import { describe, expect, it } from 'vitest'
import {
  readAgentSessionUnavailable,
  claudeInitializationSignedOut,
  agentSessionSignInCopyId
} from './agent-session-availability'
import { agentSessionFailureSentence } from './agent-session-failure-words'
import { AGENT_SESSION_FAILURE_COPY } from './agent-session-failure-copy'

describe("the host's sign-in and CLI verdict", () => {
  it.each([undefined, null, {}, { reason: 'future' }, { state: 'notSignedIn' }, 'notSignedIn'])(
    'reads an unknown or malformed verdict as unknown %j',
    (value) => {
      expect(readAgentSessionUnavailable(value)).toBeNull()
    }
  )
  it.each(['managed', 'system'] as const)('keeps %s account context', (account) => {
    expect(readAgentSessionUnavailable({ reason: 'notSignedIn', account })).toEqual({
      reason: 'notSignedIn',
      account
    })
  })
  it('drops account context this build does not know', () => {
    expect(readAgentSessionUnavailable({ reason: 'notSignedIn', account: 'future' })).toEqual({
      reason: 'notSignedIn'
    })
    expect(readAgentSessionUnavailable({ reason: 'cliMissing', account: 'system' })).toEqual({
      reason: 'cliMissing'
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
