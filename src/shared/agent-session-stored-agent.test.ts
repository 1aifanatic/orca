import { describe, expect, it } from 'vitest'
import { isPersistedAgentSessionRecord, type AgentSessionRecord } from './agent-session-record'
import { agentSessionRecordFixture } from './agent-session-record.test-fixture'
import {
  decodePersistedAgentSessionRecord,
  encodeAgentSessionRecord
} from './agent-session-record-stored-form'
import { agentSessionStoredAgents } from './agent-session-stored-agent'
import { CLAUDE_AND_CODEX_STORED_AGENTS } from './agent-session-stored-agent.test-fixture'

const GROK = { agent: 'grok', handleTransport: 'acp', accountHomeVariable: 'GROK_HOME' }
const WITH_GROK = agentSessionStoredAgents([...CLAUDE_AND_CODEX_STORED_AGENTS.values(), GROK])

function grokRecord(transport = 'acp'): AgentSessionRecord {
  const record = agentSessionRecordFixture()
  return {
    ...record,
    provider: 'grok',
    providerHandleChain: record.providerHandleChain.map((link) => ({
      ...link,
      handle: { transport, agent: 'grok', nativeId: 'grok-session-1', resumeCursor: '{"cwd":"/w"}' }
    })),
    accountHome: { variable: 'GROK_HOME', path: '/home/user/.grok' }
  }
}

describe('records of registered agents', () => {
  it('reads a record of any agent the host registered', () => {
    const stored = encodeAgentSessionRecord(grokRecord())
    expect(isPersistedAgentSessionRecord(stored, WITH_GROK)).toBe(true)
    if (!isPersistedAgentSessionRecord(stored, WITH_GROK)) {
      return
    }
    expect(decodePersistedAgentSessionRecord(stored).record).toEqual(grokRecord())
  })

  it('sets aside a record of an agent this host did not register', () => {
    expect(
      isPersistedAgentSessionRecord(
        encodeAgentSessionRecord(grokRecord()),
        CLAUDE_AND_CODEX_STORED_AGENTS
      )
    ).toBe(false)
  })

  // Whether this build can drive the chain's transport is decided when its agent would start
  // (structured-agent-session-drivability.test.ts), so a definition change never hides a chat.
  it("reads a record whose handles are in a transport other than the agent's current one", () => {
    expect(
      isPersistedAgentSessionRecord(encodeAgentSessionRecord(grokRecord('other')), WITH_GROK)
    ).toBe(true)
  })

  it('sets aside a record whose handles name another agent, or mix transports', () => {
    const record = grokRecord()
    const [link] = record.providerHandleChain
    const foreign = { ...link!, handle: { ...link!.handle, agent: 'codex' } }
    const mixed = { ...link!, linkId: 'second', handle: { ...link!.handle, transport: 'other' } }
    for (const chain of [[foreign], [link!, mixed]]) {
      expect(
        isPersistedAgentSessionRecord(
          encodeAgentSessionRecord({ ...record, providerHandleChain: chain }),
          WITH_GROK
        )
      ).toBe(false)
    }
  })

  it('keeps reading Claude and Codex records exactly as before', () => {
    const stored = encodeAgentSessionRecord(agentSessionRecordFixture())
    expect(isPersistedAgentSessionRecord(stored, CLAUDE_AND_CODEX_STORED_AGENTS)).toBe(true)
    expect(isPersistedAgentSessionRecord(stored, WITH_GROK)).toBe(true)
    expect(JSON.stringify(stored.providerHandleChain[0]?.handle)).toBe(
      '{"provider":"claude","sessionId":"provider-session-alpha-1","leafUuid":null}'
    )
  })

  it('refuses a Claude record whose handles another agent owns', () => {
    const record = agentSessionRecordFixture()
    expect(
      isPersistedAgentSessionRecord(
        encodeAgentSessionRecord({ ...record, provider: 'codex', accountHome: record.accountHome }),
        CLAUDE_AND_CODEX_STORED_AGENTS
      )
    ).toBe(false)
  })
})
