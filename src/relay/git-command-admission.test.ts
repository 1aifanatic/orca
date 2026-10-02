import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '../shared/child-process/process-spec'
import { GitAdmissionScheduler } from '../shared/git-admission-scheduler'

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }))
vi.mock('../shared/child-process/run-process', () => ({ runProcess: capture }))

import {
  _resetRelayGitAdmissionForTests,
  runGitToTermination
} from './git-handler-command-termination'

describe('relay Git command ownership', () => {
  let scheduler: GitAdmissionScheduler
  const success = { code: 0, signal: null, stdout: 'result', stderr: '', timedOut: false }

  beforeEach(() => {
    scheduler = new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 })
    _resetRelayGitAdmissionForTests(scheduler)
    capture.mockReset()
  })
  afterEach(() => _resetRelayGitAdmissionForTests())

  it('bounds reads while preserving explicit write and network timeout policy', async () => {
    capture.mockImplementation(async (spec: ProcessSpec) => {
      spec.onChildTerminated?.()
      return success
    })
    await runGitToTermination(
      ['-c', 'core.quotePath=false', 'show', 'HEAD:file'],
      { cwd: '/repo' },
      undefined
    )
    await runGitToTermination(['fetch', 'origin'], { cwd: '/repo' }, undefined)
    await runGitToTermination(['reset', '--quiet'], { cwd: '/repo', timeout: 800 }, undefined)
    expect(capture.mock.calls.map(([spec]) => spec.timeoutMs)).toEqual([120_000, null, 800])
    expect(capture.mock.calls[0][0]).toMatchObject({
      terminationBarrier: true,
      killOnOutputLimit: true
    })
  })

  it('cancels a queued read without spawning or releasing an active child', async () => {
    let finish!: () => void
    capture.mockImplementationOnce(
      (spec: ProcessSpec) =>
        new Promise((resolve) => {
          finish = () => {
            spec.onChildTerminated?.()
            resolve(success)
          }
        })
    )
    const active = runGitToTermination(['show', 'HEAD:file'], { cwd: '/repo' }, undefined)
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
    const controller = new AbortController()
    const queued = runGitToTermination(
      ['show', 'HEAD:other'],
      { cwd: '/repo', signal: controller.signal },
      undefined
    )
    const rejection = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    expect(capture).toHaveBeenCalledTimes(1)
    expect(scheduler.snapshot()).toMatchObject({ queued: 0, budgets: { general: { baseUsed: 1 } } })
    finish()
    await active
    expect(scheduler.snapshot().budgets.general.baseUsed).toBe(0)
  })

  it('holds admission after a capture rejects until child termination is reported', async () => {
    let reportTermination: (() => void) | undefined
    capture.mockImplementationOnce(async (spec: ProcessSpec) => {
      reportTermination = spec.onChildTerminated
      throw new Error('capture failed before close')
    })
    await expect(runGitToTermination(['status'], { cwd: '/repo' }, undefined)).rejects.toThrow(
      'before close'
    )
    expect(scheduler.snapshot().budgets.general.baseUsed).toBe(1)
    reportTermination?.()
    expect(scheduler.snapshot().budgets.general.baseUsed).toBe(0)
  })

  it('rejects truncated zero-exit output instead of parsing an incomplete result', async () => {
    capture.mockImplementationOnce(async (spec: ProcessSpec) => {
      spec.onChildTerminated?.()
      return { ...success, outputTruncated: true }
    })
    await expect(runGitToTermination(['log'], { cwd: '/repo' }, undefined)).rejects.toMatchObject({
      code: 'ENOBUFS'
    })
  })

  it('returns captured bytes without round-tripping through UTF-8', async () => {
    const bytes = Buffer.from([0, 255, 254, 128, 65])
    capture.mockImplementationOnce(async (spec: ProcessSpec) => {
      expect(spec.captureStdoutAsBytes).toBe(true)
      spec.onChildTerminated?.()
      return { ...success, stdout: '', stdoutBytes: bytes }
    })
    const result = await runGitToTermination(
      ['show', 'HEAD:file'],
      { cwd: '/repo', captureStdoutAsBytes: true },
      undefined
    )
    expect(result.stdoutBytes).toEqual(bytes)
  })
})
