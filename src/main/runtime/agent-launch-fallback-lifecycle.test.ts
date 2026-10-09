import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'
import { createLaunchFallbackRuntime } from './agent-launch-fallback.test-fixture'

vi.mock('../git/worktree', () => {
  const list = async () => [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/test',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return { listWorktrees: list, listWorktreesStrict: list }
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function pendingInspection() {
  const rig = await createLaunchFallbackRuntime()
  let resolve!: (process: TerminalProcessInspection) => void
  rig.inspectProcess.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  return {
    ...rig,
    resolve: () => resolve({ foregroundProcess: 'opencode', hasChildProcesses: false })
  }
}

describe('a fallback inspection that settles after the nominal one-second budget', () => {
  it.each([22_000, 5 * 60_000 + 1])(
    'still delivers on the original live terminal after a %i ms positive inspection',
    async (delay) => {
      const rig = await pendingInspection()
      const result = rig.deliver()
      await vi.advanceTimersByTimeAsync(delay)
      expect(rig.inspectProcess).toHaveBeenCalledOnce()
      expect(rig.writes).toEqual([])
      rig.resolve()
      await vi.runAllTimersAsync()
      expect(await result).toBe(true)
      expect(rig.writes).toHaveLength(2)
      expect(rig.writeTimes[0]).toBe(delay)
    }
  )

  it('rejects a changed lifecycle generation while the positive inspection is pending', async () => {
    const rig = await pendingInspection()
    const result = rig.deliver()
    await vi.advanceTimersByTimeAsync(20_000)
    rig.runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      0
    )
    rig.resolve()
    await vi.runAllTimersAsync()
    expect(await result).toBe(false)
    expect(rig.writes).toEqual([])
  })

  it('rejects an exited terminal while the positive inspection is pending', async () => {
    const rig = await pendingInspection()
    const result = rig.deliver()
    await vi.advanceTimersByTimeAsync(20_000)
    await rig.runtime.onPtyExit('pty-prompt', 0)
    rig.resolve()
    await vi.runAllTimersAsync()
    expect(await result).toBe(false)
    expect(rig.writes).toEqual([])
  })

  it('does not reuse a replacement that appeared during the preceding composer wait', async () => {
    const rig = await createLaunchFallbackRuntime({
      process: { foregroundProcess: 'opencode', hasChildProcesses: false }
    })
    const result = rig.deliver()
    await vi.advanceTimersByTimeAsync(1_000)
    rig.runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      0
    )
    await vi.runAllTimersAsync()
    expect(await result).toBe(false)
    expect(rig.writes).toEqual([])
  })
})
