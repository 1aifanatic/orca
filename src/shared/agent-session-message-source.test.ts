import { describe, expect, it } from 'vitest'
import {
  readAgentSessionMessageSource,
  storedAgentSessionMessageSource,
  type AgentMessageSource
} from './agent-session-message-source'

const SENDER = { party: { address: 'term_w', terminalHandle: 'term_w', orcaSessionId: null } }
const MAIL: AgentMessageSource = {
  kind: 'agent',
  senders: [SENDER],
  orchestration: {
    message: 'mail',
    mailbox: 'run:r1',
    dispatchId: null,
    messages: [{ messageId: 'm1', runId: 'r1', from: 'term_w' }]
  }
}

describe('reading a stored message source', () => {
  it('reads back what it stores', () => {
    expect(readAgentSessionMessageSource(storedAgentSessionMessageSource(MAIL))).toEqual(MAIL)
  })

  it("keeps an agent's source it cannot fully read an agent's, carrying no mail it knows", () => {
    const stored = storedAgentSessionMessageSource(MAIL)
    const unknown = { message: 'unknown' }
    // A newer build's message kind, a newer version, a sender this build cannot read.
    expect(
      readAgentSessionMessageSource({ ...stored, orchestration: { message: 'task', taskId: 't' } })
    ).toEqual({ kind: 'agent', senders: [SENDER], orchestration: unknown })
    expect(readAgentSessionMessageSource({ ...stored, v: 2 })).toEqual({
      kind: 'agent',
      senders: [SENDER],
      orchestration: unknown
    })
    expect(readAgentSessionMessageSource({ ...stored, senders: [{ party: 7 }] })).toEqual({
      ...MAIL,
      senders: []
    })
  })

  it("reads no value, or one with no readable kind, as the person's", () => {
    for (const stored of [undefined, null, {}, { v: 9 }, { v: 1, kind: 'robot' }, 'agent']) {
      expect(readAgentSessionMessageSource(stored)).toEqual({ kind: 'user' })
    }
  })
})
