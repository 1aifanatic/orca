import { describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import { codexCliInstallation } from '../../shared/codex-cli-installation'
import { codexMaintenanceAction } from '../../shared/codex-cli-maintenance'
import type { ProcessSpec } from '../../shared/child-process/run-process'
import { CodexMaintenanceRunner } from './codex-maintenance-runner'

vi.mock('./codex-maintenance-command', () => ({ resolveCodexMaintenanceCommand: vi.fn() }))

function fixture(exitCode = 0, npmInstalled = true) {
  const installation = codexCliInstallation(true, '0.135.0')
  const ready = codexCliInstallation(true, '0.136.0')
  const action = codexMaintenanceAction(installation, npmInstalled)
  const spec: ProcessSpec = {
    program: process.execPath,
    args: [
      '-e',
      `process.stdout.write('first chunk\\n'); setTimeout(() => { process.stderr.write('last chunk\\n'); process.exit(${exitCode}) }, 100)`
    ]
  }
  const resolve = vi.fn().mockResolvedValue({ installation, action, spec })
  const spawn = vi.fn(spawnProcess)
  const invalidate = vi.fn(() => {
    resolve.mockResolvedValue({
      installation: exitCode ? installation : ready,
      action: exitCode ? action : null,
      spec: exitCode ? spec : null
    })
  })
  const runner = new CodexMaintenanceRunner({ resolve, spawn, invalidate })
  return { runner, resolve, spawn, invalidate, action }
}

async function finished(runner: CodexMaintenanceRunner, id: string) {
  await vi.waitFor(
    async () => {
      expect((await runner.status(id)).job?.phase).toBe('completed')
    },
    { timeout: 5_000 }
  )
  return runner.status(id)
}

describe('host-owned Codex maintenance runner', () => {
  it('starts one job for simultaneous calls and keeps the lock until the child exits', async () => {
    const f = fixture()
    const [first, second] = await Promise.all([f.runner.start(), f.runner.start()])
    expect(first.job?.id).toBe(second.job?.id)
    expect((await f.runner.start()).job?.id).toBe(first.job?.id)
    expect(f.spawn).toHaveBeenCalledTimes(1)
    if (!first.job) {
      throw new Error('No job')
    }
    await finished(f.runner, first.job.id)
  })

  it('streams stdout and stderr while running, then invalidates and checks installation on exit', async () => {
    const f = fixture()
    const state = await f.runner.start()
    if (!state.job) {
      throw new Error('No job')
    }
    const id = state.job.id
    await vi.waitFor(async () => {
      const current = await f.runner.status(id)
      expect(current.job?.output).toContain('first chunk')
      expect(current.job?.phase).toBe('running')
    })
    const result = await finished(f.runner, id)
    expect(result.job?.output).toContain('last chunk')
    expect(result.job?.exitCode).toBe(0)
    expect(result.installation.status).toBe('ready')
    expect(result.action).toBeNull()
    expect(f.invalidate).toHaveBeenCalledTimes(1)
    expect(f.resolve.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      f.invalidate.mock.invocationCallOrder[0]
    )
  })

  it('keeps the failure exit code and log, rechecks, and permits an explicit retry', async () => {
    const f = fixture(17)
    const first = await f.runner.start()
    if (!first.job) {
      throw new Error('No job')
    }
    const result = await finished(f.runner, first.job.id)
    expect(result.job?.exitCode).toBe(17)
    expect(result.job?.output).toContain('last chunk')
    expect(result.installation.status).toBe('unsupported')
    const retry = await f.runner.start()
    expect(retry.job?.id).not.toBe(first.job.id)
    if (!retry.job) {
      throw new Error('No retry')
    }
    await finished(f.runner, retry.job.id)
  })

  it('records a spawn failure and releases the job after rechecking', async () => {
    const f = fixture()
    f.spawn.mockImplementation(() => {
      throw new Error('permission denied')
    })
    const state = await f.runner.start()
    if (!state.job) {
      throw new Error('No job')
    }
    const result = await finished(f.runner, state.job.id)
    expect(result.job?.error).toBe('permission denied')
    expect(f.invalidate).toHaveBeenCalledTimes(1)
  })

  it('does not run anything from a status read or for a supported installation', async () => {
    const f = fixture()
    await f.runner.status()
    expect(f.spawn).not.toHaveBeenCalled()
    f.resolve.mockResolvedValue({
      installation: codexCliInstallation(true, '0.136.0'),
      action: null,
      spec: null
    })
    await expect(f.runner.start()).rejects.toThrow('does not need')
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('keeps the verified result when a status read started before the update finishes late', async () => {
    const f = fixture()
    let completeStatus: (value: unknown) => void = () => {}
    f.resolve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeStatus = resolve
        })
    )
    const pending = f.runner.status()
    const started = await f.runner.start()
    if (!started.job) {
      throw new Error('No job')
    }
    await finished(f.runner, started.job.id)
    completeStatus({
      installation: codexCliInstallation(true, '0.135.0'),
      action: f.action,
      spec: null
    })
    expect((await pending).installation.status).toBe('ready')
  })

  it('bounds streamed output while retaining final diagnostics', async () => {
    const f = fixture()
    f.resolve.mockResolvedValue({
      installation: codexCliInstallation(false, null),
      action: codexMaintenanceAction(codexCliInstallation(false, null), false),
      spec: {
        program: process.execPath,
        args: ['-e', "process.stdout.write('x'.repeat(200000) + 'final diagnostic')"]
      }
    })
    const state = await f.runner.start()
    if (!state.job) {
      throw new Error('No job')
    }
    const result = await finished(f.runner, state.job.id)
    expect(Buffer.byteLength(result.job?.output ?? '')).toBeLessThanOrEqual(128 * 1024)
    expect(result.job?.output).toContain('final diagnostic')
  })
})
