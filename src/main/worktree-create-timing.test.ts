import { describe, expect, it } from 'vitest'
import { createWorktreeCreateTimingRecorder } from './worktree-create-timing'

describe('createWorktreeCreateTimingRecorder', () => {
  it('records ordered phase timings and total duration', async () => {
    const samples = [100, 105, 112, 130, 144, 155]
    const recorder = createWorktreeCreateTimingRecorder(() => samples.shift() ?? 155)

    const syncResult = recorder.timeSync('resolve_name', () => 'branch')
    const asyncResult = await recorder.time('git_worktree_add', async () => 'created')

    expect(syncResult).toBe('branch')
    expect(asyncResult).toBe('created')
    expect(recorder.finish()).toEqual({
      totalDurationMs: 55,
      phases: [
        { phase: 'resolve_name', startedAtMs: 5, durationMs: 7 },
        { phase: 'git_worktree_add', startedAtMs: 30, durationMs: 14 }
      ]
    })
  })

  it('carries the execution host and worktree count only once recorded', () => {
    const recorder = createWorktreeCreateTimingRecorder(() => 0)
    expect(recorder.finish()).not.toHaveProperty('executionHost')
    expect(recorder.finish()).not.toHaveProperty('worktreeCount')

    recorder.recordExecutionHost('local')
    recorder.recordExecutionHost('wsl')
    recorder.recordWorktreeCount(0)

    expect(recorder.finish()).toMatchObject({ executionHost: 'wsl', worktreeCount: 0 })
  })

  describe('failedPhase', () => {
    it('names the phase whose operation threw', async () => {
      const recorder = createWorktreeCreateTimingRecorder(() => 0)
      await recorder.time('resolve_name', async () => undefined)
      await expect(
        recorder.time('git_worktree_add', async () => {
          throw new Error('boom')
        })
      ).rejects.toThrow('boom')

      expect(recorder.failedPhase()).toBe('git_worktree_add')
      // The phase that threw is still timed.
      expect(recorder.finish().phases.map((phase) => phase.phase)).toEqual([
        'resolve_name',
        'git_worktree_add'
      ])
    })

    it('is undefined when every phase succeeded', async () => {
      const recorder = createWorktreeCreateTimingRecorder(() => 0)
      await recorder.time('git_worktree_add', async () => undefined)
      expect(recorder.failedPhase()).toBeUndefined()
    })

    it('names the enclosing phase when an inner failure propagates through it', async () => {
      const recorder = createWorktreeCreateTimingRecorder(() => 0)
      await expect(
        recorder.time('git_worktree_add', () =>
          recorder.time('prepared_checkout_wait', async () => {
            throw new Error('prepare failed')
          })
        )
      ).rejects.toThrow('prepare failed')

      expect(recorder.failedPhase()).toBe('git_worktree_add')
    })

    it('forgets an inner failure the enclosing phase recovered from', async () => {
      const recorder = createWorktreeCreateTimingRecorder(() => 0)
      await recorder.time('git_worktree_add', async () => {
        await recorder
          .time('prepared_checkout_wait', async () => {
            throw new Error('prepare failed')
          })
          .catch(() => undefined)
      })

      expect(recorder.failedPhase()).toBeUndefined()
    })

    it('forgets a caught failure once a later phase starts', async () => {
      const recorder = createWorktreeCreateTimingRecorder(() => 0)
      await recorder
        .time('create_symlinks', async () => {
          throw new Error('symlink failed')
        })
        .catch(() => undefined)
      await recorder.time('prepare_setup', async () => undefined)

      expect(recorder.failedPhase()).toBeUndefined()
    })

    it('names a sync phase that threw', () => {
      const recorder = createWorktreeCreateTimingRecorder(() => 0)
      expect(() =>
        recorder.timeSync('persist_metadata', () => {
          throw new Error('disk full')
        })
      ).toThrow('disk full')

      expect(recorder.failedPhase()).toBe('persist_metadata')
    })
  })
})
