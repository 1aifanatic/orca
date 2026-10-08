import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { PANE_KEY } from './agent-hook-listener-test-harness'

describe("a Codex child's agent type and model", () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
    post({ hook_event_name: 'UserPromptSubmit', prompt: 'split the work' })
    post({
      hook_event_name: 'SubagentStart',
      agent_id: 'child',
      agent_type: 'explorer',
      model: 'model-a'
    })
  })

  function post(payload: Record<string, unknown>): ReturnType<typeof normalizeHookPayload> {
    return normalizeHookPayload(state, 'codex', { paneKey: PANE_KEY, payload }, 'production')
  }

  function startChild(fields: Record<string, unknown>) {
    return post({ hook_event_name: 'SubagentStart', agent_id: 'child', ...fields })?.payload
      .subagents?.[0]
  }

  it('keeps the model when the same agent type is announced again without one', () => {
    expect(startChild({ agent_type: 'explorer' })).toMatchObject({
      agentType: 'explorer',
      model: 'model-a'
    })
  })

  it('clears the model when a different agent type is announced without one', () => {
    expect(startChild({ agent_type: 'worker' })).toMatchObject({
      agentType: 'worker',
      model: undefined
    })
  })

  it('takes the new model when a different agent type is announced with one', () => {
    expect(startChild({ agent_type: 'worker', model: 'model-b' })).toMatchObject({
      agentType: 'worker',
      model: 'model-b'
    })
  })
})
