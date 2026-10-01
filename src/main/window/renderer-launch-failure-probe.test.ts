import { afterEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock, recordDurableCrashBreadcrumbMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  recordDurableCrashBreadcrumbMock: vi.fn()
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: recordDurableCrashBreadcrumbMock
}))

import {
  classifyLaunchProbeError,
  probeRendererLaunchCapacity,
  recordRendererLaunchFailureProbe
} from './renderer-launch-failure-probe'

function spawnError(code: string): Error {
  return Object.assign(new Error(`spawn /bin/sh ${code}`), { code, errno: -35, syscall: 'spawn' })
}

describe('classifyLaunchProbeError', () => {
  it.each(['EAGAIN', 'EACCES', 'ENOENT', 'EMFILE'])('reports the spawn errno %s', (code) => {
    expect(classifyLaunchProbeError(spawnError(code))).toBe(code)
  })

  it.each([
    ['a plain error', new Error('boom')],
    ['a non-errno code', Object.assign(new Error('x'), { code: 'ERR_INVALID_ARG_TYPE' })],
    ['a numeric code', Object.assign(new Error('x'), { code: 11 })],
    ['a non-error throw', 'EAGAIN']
  ])('reports unknown for %s', (_label, error) => {
    expect(classifyLaunchProbeError(error)).toBe('unknown')
  })
})

describe('probeRendererLaunchCapacity', () => {
  afterEach(() => {
    runProcessMock.mockReset()
    recordDurableCrashBreadcrumbMock.mockReset()
  })

  it('reports ok for any child that started, whatever its exit', async () => {
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    await expect(probeRendererLaunchCapacity('darwin')).resolves.toBe('ok')
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: '/bin/sh', args: ['-c', 'exit 0'] })
    )
  })

  it('spawns an absolute System32 binary on Windows, never a shell', async () => {
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    await probeRendererLaunchCapacity('win32')
    const [spec] = runProcessMock.mock.calls[0] ?? []
    expect(spec.program).toMatch(/System32[\\/]whoami\.exe$/i)
  })

  it('records the refused spawn as a durable breadcrumb', async () => {
    runProcessMock.mockRejectedValue(spawnError('EAGAIN'))
    await expect(recordRendererLaunchFailureProbe({ exitCode: 1003 }, 10_000)).resolves.toBe(
      'EAGAIN'
    )
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith('renderer_launch_failed_probe', {
      spawnError: 'EAGAIN',
      exitCode: 1003
    })
  })

  it('probes once for the duplicate render-process-gone of one failed launch', async () => {
    runProcessMock.mockRejectedValue(spawnError('EAGAIN'))
    await recordRendererLaunchFailureProbe({ exitCode: 1003 }, 50_000)
    await recordRendererLaunchFailureProbe({ exitCode: 1003 }, 50_010)
    expect(runProcessMock).toHaveBeenCalledOnce()
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledOnce()

    // The next backoff retry fails again: a fresh probe and breadcrumb.
    await recordRendererLaunchFailureProbe({ exitCode: 1003 }, 50_250)
    expect(runProcessMock).toHaveBeenCalledTimes(2)
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledTimes(2)
  })
})
