// A Codex turn ends once. Codex's own report of the end (its Interrupt or Stop hook, or the marker
// it writes to its rollout) settles the turn it names; once the turn is over, a later fact for it
// is a restatement, and a fact for any other turn is Codex working again. A Stop alone is not the
// end: a Stop hook that blocks makes Codex continue the same turn.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import {
  shouldPollHookTranscript,
  transcriptPollUpdate
} from './agent-hook-listener/transcript-poll-policy'
import { normalizeAndAccept } from './agent-hook-listener-test-harness'

describe('the Codex main agent turn, decided by turn id', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  const hook = (payload: Record<string, unknown>) => normalizeAndAccept(state, 'codex', payload)

  it('keeps a cancelled turn cancelled against a later hook for that same turn', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    hook({ hook_event_name: 'Interrupt', turn_id: 'turn-1' })
    // A hook the cancel overtook in delivery, then a Stop racing the Interrupt.
    for (const late of [
      { hook_event_name: 'PostToolUse', turn_id: 'turn-1', tool_name: 'Bash' },
      { hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'Bash' },
      { hook_event_name: 'Stop', turn_id: 'turn-1' }
    ]) {
      expect(hook(late)?.payload).toMatchObject({
        state: 'done',
        interrupted: true,
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
    }
  })

  it('reads a hook for another turn as Codex working again, with or without a prompt', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    hook({ hook_event_name: 'Interrupt', turn_id: 'turn-1' })
    // A turn Codex starts on its own fires no UserPromptSubmit; its first hook names the new turn.
    const resumed = hook({ hook_event_name: 'PreToolUse', turn_id: 'turn-2', tool_name: 'Bash' })

    expect(resumed?.payload).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    expect(resumed?.payload.interrupted).toBeFalsy()
    expect(hook({ hook_event_name: 'Stop', turn_id: 'turn-2' })?.payload.mainAgent).toEqual({
      state: 'done',
      stateStartedAt: expect.any(Number)
    })
  })

  it('reads a turn a blocking Stop hook continued as working, then cancelled on its Interrupt', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    hook({ hook_event_name: 'Stop', turn_id: 'turn-1' })
    // Another Stop hook blocked, so Codex continues turn-1 without a new prompt or turn id.
    const continued = hook({ hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'Bash' })
    expect(continued?.payload).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

    expect(hook({ hook_event_name: 'Interrupt', turn_id: 'turn-1' })?.payload).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })

  it('does not clear the roster on Interrupt: the subagent it left running holds the row', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-1', turn_id: 'child-turn' })
    const cancelled = hook({ hook_event_name: 'Interrupt', turn_id: 'turn-1' })

    expect(cancelled?.payload).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' },
      subagents: [expect.objectContaining({ id: 'agent-1', state: 'working' })]
    })
    expect(
      hook({ hook_event_name: 'SubagentStop', agent_id: 'agent-1', turn_id: 'child-turn' })?.payload
    ).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })
})

describe("the Codex main agent turn, settled from Codex's rollout", () => {
  let state: HookListenerState
  let dir: string
  let rollout: string

  beforeEach(() => {
    state = createHookListenerState()
    dir = mkdtempSync(join(tmpdir(), 'codex-turn-rollout-'))
    rollout = join(dir, 'rollout-parent.jsonl')
    writeFileSync(rollout, marker('task_started', 'turn-1'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function marker(type: string, turnId: string): string {
    return `${JSON.stringify({ type: 'event_msg', payload: { type, turn_id: turnId } })}\n`
  }

  const hook = (payload: Record<string, unknown>) =>
    normalizeAndAccept(state, 'codex', { transcript_path: rollout, ...payload })

  it('reads turn_aborted for the current turn as the cancel, on any event, a child one included', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-1' })
    appendFileSync(rollout, marker('turn_aborted', 'turn-1'))

    const child = normalizeAndAccept(state, 'codex', {
      hook_event_name: 'PostToolUse',
      agent_id: 'agent-1',
      transcript_path: join(dir, 'rollout-child.jsonl'),
      tool_name: 'Bash'
    })
    expect(child?.payload).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })

  it('reads task_complete for the current turn as a completed turn', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    appendFileSync(rollout, marker('task_complete', 'turn-1'))

    const replayed = hook({ hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'Bash' })
    expect(replayed?.payload.mainAgent).toEqual({
      state: 'done',
      stateStartedAt: expect.any(Number)
    })
  })

  it('keeps a turn its rollout records complete against a later fact for it', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    hook({ hook_event_name: 'Stop', turn_id: 'turn-1' })
    appendFileSync(rollout, marker('task_complete', 'turn-1'))

    for (const late of [
      { hook_event_name: 'PostToolUse', turn_id: 'turn-1', tool_name: 'Bash' },
      { hook_event_name: 'Interrupt', turn_id: 'turn-1' }
    ]) {
      expect(hook(late)?.payload.mainAgent).toEqual({
        state: 'done',
        stateStartedAt: expect.any(Number)
      })
    }
  })

  it("ignores another turn's end", () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-2' })
    appendFileSync(rollout, marker('turn_aborted', 'turn-1'))

    expect(
      hook({ hook_event_name: 'PreToolUse', turn_id: 'turn-2', tool_name: 'Bash' })?.payload
        .mainAgent
    ).toMatchObject({ state: 'working' })
  })

  it('polls while the turn is open and stops once it ends', () => {
    const working = hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })!
    expect(shouldPollHookTranscript(state, 'codex', working)).toBe(true)

    appendFileSync(rollout, marker('turn_aborted', 'turn-1'))
    // The poll replays the last body; what it reads from the rollout is what it publishes.
    const polled = hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })!
    expect(transcriptPollUpdate('codex', working, polled)?.payload.mainAgent).toMatchObject({
      state: 'done',
      outcome: 'cancellation'
    })
    expect(shouldPollHookTranscript(state, 'codex', polled)).toBe(false)
    expect(transcriptPollUpdate('codex', polled, polled)).toBeUndefined()
  })

  it('does not poll a turn it cannot settle: no rollout, or no turn id to match', () => {
    const noRollout = createHookListenerState()
    const event = normalizeAndAccept(noRollout, 'codex', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'go',
      turn_id: 'turn-1'
    })!
    expect(shouldPollHookTranscript(noRollout, 'codex', event)).toBe(false)

    const unnamed = hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })!
    expect(shouldPollHookTranscript(state, 'codex', unnamed)).toBe(false)
  })
})
