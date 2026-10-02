// When the host says a Codex reasoning item is open, and whose words the turn's line carries.
import { describe, expect, it } from 'vitest'
import type { AgentSessionTurnActivity } from '../../shared/agent-session-wire'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { MAX_CODEX_ACTIVE_ITEMS } from './codex-structured-journal-limits'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'

function notification(method: string, params: unknown): CodexStructuredSessionEvent {
  return { type: 'notification', sessionId: SESSION_ID, threadId: THREAD_ID, method, params }
}

function turn() {
  const activities: (AgentSessionTurnActivity | null)[] = []
  const translator = createCodexJournalTranslator({
    sink: {
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {},
      setActivity: (activity) => activities.push(activity)
    },
    primaryThreadId: () => THREAD_ID,
    sessionId: SESSION_ID,
    schedule: (run) => {
      run()
      return () => {}
    }
  })
  const item = (method: 'item/started' | 'item/completed', type: string, id: string): void => {
    translator.handle(notification(method, { turnId: TURN_ID, item: { type, id } }))
  }
  translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
  const latest = () => activities.at(-1) ?? null
  return { translator, item, latest }
}

describe("Codex's open reasoning, as the host reports it live", () => {
  it('opens at item/started, summaries or not, and closes at its completion', () => {
    const { item, latest } = turn()
    item('item/started', 'reasoning', 'r-1')
    expect(latest()).toEqual({
      turnId: TURN_ID,
      text: 'Thinking through the request',
      reasoning: { session: true, subagents: [] }
    })
    item('item/completed', 'reasoning', 'r-1')
    expect(latest()).toBeNull()
  })

  it('closes when the turn completes or the provider exits', () => {
    const settled = turn()
    settled.item('item/started', 'reasoning', 'r-1')
    settled.translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))
    expect(settled.latest()).toBeNull()

    const exited = turn()
    exited.item('item/started', 'reasoning', 'r-1')
    exited.translator.handle({ type: 'ended', sessionId: SESSION_ID, reason: 'exit' })
    expect(exited.latest()).toBeNull()
  })

  it('closes when the bounded live set evicts the item', () => {
    const { item, latest } = turn()
    item('item/started', 'reasoning', 'r-1')
    for (let index = 0; index < MAX_CODEX_ACTIVE_ITEMS; index += 1) {
      item('item/started', 'agentMessage', `m-${index}`)
    }
    expect(latest()?.reasoning).toBeUndefined()
  })
})

describe("a Codex item's activity words", () => {
  it('end with the item that set them', () => {
    const { item, latest } = turn()
    item('item/started', 'commandExecution', 'c-1')
    expect(latest()?.text).toBe('Running a command')
    item('item/completed', 'commandExecution', 'c-1')
    expect(latest()).toBeNull()
  })

  it('stay when an item that did not set them completes', () => {
    const { item, latest } = turn()
    item('item/started', 'reasoning', 'r-1')
    item('item/started', 'commandExecution', 'c-1')
    item('item/completed', 'reasoning', 'r-1')
    expect(latest()).toEqual({ turnId: TURN_ID, text: 'Running a command' })
  })
})
