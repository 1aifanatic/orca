// A subagent's prompt card counts as open only while the journal holds it pending: from the moment
// its rows land until anyone closes it.

import { describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionSinkBarrier } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { ClaudeJournalPrompts } from './claude-structured-journal-prompts'

function cards(options: { accepted?: boolean; asker?: string } = {}) {
  let land: (barrier: StructuredAgentSessionSinkBarrier) => void = () => {}
  const prompts = new ClaudeJournalPrompts({
    sink: {
      appendItem: () => {},
      tryAppendItem: () =>
        options.accepted === false
          ? { accepted: false, reason: 'backpressure' }
          : { accepted: true },
      appendTombstone: () => {},
      publish: () => {},
      written: () =>
        new Promise((resolve) => {
          land = resolve
        })
    },
    turnScope: () => AGENT_JOURNAL_THREAD_SCOPE,
    producerOf: () =>
      options.asker === undefined ? {} : { agentId: options.asker, producerKind: 'agent' }
  })
  prompts.handle({
    type: 'prompt',
    sessionId: 'session-1',
    prompt: {
      requestId: 'req-1',
      promptKey: 'req-1',
      toolUseId: 'toolu-1',
      toolName: 'Bash',
      kind: 'approval',
      input: { command: 'touch f' },
      suggestions: [],
      questionIds: [],
      settle: vi.fn()
    }
  })
  const open = () => [...prompts.openCards()]
  const landed = async (barrier: StructuredAgentSessionSinkBarrier = { ok: true }) => {
    const written = prompts.whenWritten('req-1')
    land(barrier)
    await written
  }
  return {
    prompts,
    open,
    landed,
    land: (barrier: StructuredAgentSessionSinkBarrier) => land(barrier)
  }
}

describe("a subagent's prompt card", () => {
  it('opens once its rows land, before anything waiting on that hears of it', async () => {
    const { prompts, open, landed } = cards({ asker: 'agent-1' })
    expect(open()).toEqual([])
    const heard = prompts.whenWritten('req-1')?.then(open)
    await landed()
    expect(await heard).toEqual([{ promptKey: 'req-1', asker: 'agent-1' }])
  })

  it('never opens when the sink refused its rows or failed writing them', async () => {
    const refused = cards({ asker: 'agent-1', accepted: false })
    await refused.landed()
    expect(refused.open()).toEqual([])
    const failed = cards({ asker: 'agent-1' })
    await failed.landed({ ok: false, error: new Error('write failed') })
    expect(failed.open()).toEqual([])
  })

  it('closes when answered, handed to the host, or withdrawn, and reopens when handed back', async () => {
    const answered = cards({ asker: 'agent-1' })
    await answered.landed()
    answered.prompts.resolve('req-1')
    expect(answered.open()).toEqual([])

    const dismissed = cards({ asker: 'agent-1' })
    await dismissed.landed()
    const handBack = dismissed.prompts.handOver('req-1')
    expect(dismissed.open()).toEqual([])
    handBack()
    expect(dismissed.open()).toEqual([{ promptKey: 'req-1', asker: 'agent-1' }])

    const withdrawn = cards({ asker: 'agent-1' })
    await withdrawn.landed()
    withdrawn.prompts.cancel('req-1')
    expect(withdrawn.open()).toEqual([])
  })

  it('opens a card handed back before its rows landed once they land', async () => {
    const { prompts, open, land } = cards({ asker: 'agent-1' })
    const written = prompts.whenWritten('req-1')
    const handBack = prompts.handOver('req-1')
    handBack()
    land({ ok: true })
    await written
    expect(open()).toEqual([{ promptKey: 'req-1', asker: 'agent-1' }])
  })

  it('is closed before it lands, so a late write does not open it', async () => {
    const { prompts, open, land } = cards({ asker: 'agent-1' })
    const written = prompts.whenWritten('req-1')
    prompts.resolve('req-1')
    expect(prompts.whenWritten('req-1')).toBeUndefined()
    land({ ok: true })
    await written
    expect(open()).toEqual([])
  })

  it("leaves the session's own card out", async () => {
    const { open, landed } = cards()
    await landed()
    expect(open()).toEqual([])
  })
})
