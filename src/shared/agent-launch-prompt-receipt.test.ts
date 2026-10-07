import { describe, expect, it } from 'vitest'
import { isAgentLaunchResult } from './agent-launch-intent'

const RESULT = {
  outcome: { kind: 'terminal', handle: 'term_1' },
  worktreeId: 'wt-1',
  receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'x' }
}

describe('a recorded launch result whose prompt was written without seeing the composer', () => {
  it.each([true, false])('reads with composerUnobserved: %s', (composerUnobserved) => {
    expect(
      isAgentLaunchResult({
        ...RESULT,
        prompt: { delivery: 'submit', outcome: 'handed-to-terminal', composerUnobserved }
      })
    ).toBe(true)
  })

  it('rejects a value that is not a boolean', () => {
    expect(
      isAgentLaunchResult({
        ...RESULT,
        prompt: { delivery: 'submit', outcome: 'handed-to-terminal', composerUnobserved: 'yes' }
      })
    ).toBe(false)
  })
})
