import { describe, expect, it, vi } from 'vitest'
import { createClaudeThinkingDisplaySupport } from './claude-thinking-display-support'

const LAUNCH = { command: '/bin/claude', cwd: '/repo', env: { PATH: '/shims' } }
const UNKNOWN_FLAG = new Error(
  "claude stream-json exited (code 1): error: unknown option '--thinking-display'"
)

function supportWith(probe: (command: string) => Promise<string | null>) {
  const calls = vi.fn(probe)
  const support = createClaudeThinkingDisplaySupport({
    probe: (command, launch) => calls(command, launch),
    keyOf: async (command, cwd) => `${command}\n${cwd}`,
    budgetMs: 20
  })
  return { support, calls }
}

describe('the thinking-display flag a launch passes', () => {
  it("probes with the launch's own cwd and env, then answers from memory", async () => {
    const { support, calls } = supportWith(async () => '2.1.280')
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({ 'thinking-display': 'summarized' })
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({ 'thinking-display': 'summarized' })
    expect(calls).toHaveBeenCalledTimes(1)
    expect(calls).toHaveBeenCalledWith('/bin/claude', { cwd: '/repo', env: { PATH: '/shims' } })
  })

  it('asks again per workspace: a shim can pick a different CLI there', async () => {
    const { support, calls } = supportWith(async () => '2.1.280')
    await support.argsFor(LAUNCH)
    await support.argsFor({ ...LAUNCH, cwd: '/other' })
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('passes nothing to a CLI older than the flag, and remembers that answer', async () => {
    const { support, calls } = supportWith(async () => '2.1.92')
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({})
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({})
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('launches without the flag past the budget, and caches nothing', async () => {
    const { support, calls } = supportWith(() => new Promise<string | null>(() => {}))
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({})
    expect(calls).toHaveBeenCalledTimes(1)
    const answering = supportWith(async () => null)
    await expect(answering.support.argsFor(LAUNCH)).resolves.toEqual({})
    await answering.support.argsFor(LAUNCH)
    // A failed probe is asked again: only an answer is kept.
    expect(answering.calls).toHaveBeenCalledTimes(2)
  })

  it('waits for a probe that answers within the budget', async () => {
    const { support } = supportWith(
      () => new Promise((resolve) => setTimeout(() => resolve('2.1.280'), 5))
    )
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({ 'thinking-display': 'summarized' })
  })

  it('stops passing the flag to a binary that exited refusing it', async () => {
    const { support, calls } = supportWith(async () => '2.1.280')
    await support.argsFor(LAUNCH)
    support.observeExit(LAUNCH, UNKNOWN_FLAG)
    await vi.waitFor(async () => expect(await support.argsFor(LAUNCH)).toEqual({}))
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('records nothing for any other startup failure', async () => {
    const { support } = supportWith(async () => '2.1.280')
    await support.argsFor(LAUNCH)
    support.observeExit(LAUNCH, new Error('claude stream-json exited (code 1): not signed in'))
    support.observeExit(LAUNCH, new Error("error: unknown option '--thinking'"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({ 'thinking-display': 'summarized' })
  })
})
