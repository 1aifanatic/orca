import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { spawnManagedProviderProcess } from './managed-provider-process'
import type { ProviderProcessTree, ProviderProcessVerdict } from './provider-process-close'

const mocks = vi.hoisted(() => ({
  capture: vi.fn(async () => null),
  windowsTree: vi.fn(async () => {})
}))
vi.mock('../pty-descendant-termination', () => ({ captureDescendantSnapshot: mocks.capture }))
vi.mock('../windows-process-tree-kill', () => ({ terminateWindowsProcessTree: mocks.windowsTree }))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

function fakeChild(pid: number | null = 9_999_999) {
  const child = Object.assign(new EventEmitter(), {
    pid: pid ?? undefined,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  const spawn = vi.fn<typeof spawnProcess>(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The managed lifecycle reads only events, pid, streams and kill from this fixture.
    return child as unknown as ReturnType<typeof spawnProcess>
  })
  return { child, spawn }
}

function launch(fixture: ReturnType<typeof fakeChild>, platform: NodeJS.Platform = 'darwin') {
  return spawnManagedProviderProcess(
    { command: 'fixture-provider', args: ['serve'], cwd: '/workspace' },
    {
      spawnImpl: fixture.spawn,
      platform,
      site: 'fixture-provider-teardown',
      policy: () => ({ gracefulExitMs: 100, forcedExitMs: 50 })
    }
  )
}

function fakeTree(initial: ProviderProcessVerdict = 'unverifiable') {
  let verdict = initial
  const tree: ProviderProcessTree = {
    capture: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    reap: vi.fn(async () => verdict),
    get treeVerdict() {
      return verdict
    }
  }
  return {
    tree,
    setVerdict: (next: ProviderProcessVerdict) => {
      verdict = next
    }
  }
}

describe('managed provider process', () => {
  it('applies launch environment and uses the supervisor on its execution platform', () => {
    const fixture = fakeChild()
    const managed = spawnManagedProviderProcess(
      {
        command: 'fixture-provider',
        args: [],
        env: { AGENT_HOME: '/pinned' },
        envToDelete: ['SECRET']
      },
      {
        spawnImpl: fixture.spawn,
        platform: 'darwin',
        inheritedEnv: { SECRET: 'inherited', PATH: '/bin' },
        site: 'fixture',
        policy: () => ({ gracefulExitMs: 100, forcedExitMs: 50 })
      }
    )
    expect(managed.supervised).toBe(true)
    expect(fixture.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ AGENT_HOME: '/pinned', PATH: '/bin' })
      })
    )
    expect(fixture.spawn.mock.calls[0][0].env).not.toHaveProperty('SECRET')
    expect(managed.rootVerdict).toBe('unverifiable')
  })

  it('observes exit once across exit and close, including a late subscriber', async () => {
    const fixture = fakeChild()
    const managed = launch(fixture)
    const onExit = vi.fn()
    managed.onExit(onExit)
    fixture.child.emit('exit', 7, 'SIGTERM')
    fixture.child.emit('close', 7, 'SIGTERM')
    fixture.child.emit('exit', 8, 'SIGKILL')
    await managed.exitPromise
    expect(onExit).toHaveBeenCalledExactlyOnceWith({
      code: 7,
      signal: 'SIGTERM',
      processless: false
    })
    const late = vi.fn()
    managed.onExit(late)
    expect(late).toHaveBeenCalledExactlyOnceWith({ code: 7, signal: 'SIGTERM', processless: false })
    await expect(managed.close()).resolves.toBe('exited')
    expect(fixture.child.kill).not.toHaveBeenCalled()
  })

  it('proves stdin-close exit without forcing and clears the grace timer', async () => {
    vi.useFakeTimers()
    const fixture = fakeChild()
    const managed = launch(fixture)
    fixture.child.stdin.once('finish', () => fixture.child.emit('exit', 0, null))
    const closing = managed.close()
    expect(fixture.child.stdin.writableEnded).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    await expect(closing).resolves.toBe('exited')
    expect(fixture.child.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('joins a close, returns unverifiable after the kill deadline, and retries on the same child', async () => {
    vi.useFakeTimers()
    const fixture = fakeChild()
    const managed = launch(fixture)
    const first = managed.close()
    expect(managed.close()).toBe(first)
    await vi.advanceTimersByTimeAsync(150)
    await expect(first).resolves.toBe('unverifiable')
    expect(fixture.child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(managed.exited).toBe(false)
    fixture.child.kill.mockImplementation(() => {
      fixture.child.emit('exit', null, 'SIGKILL')
      return true
    })
    const second = managed.close()
    await vi.advanceTimersByTimeAsync(150)
    await expect(second).resolves.toBe('exited')
    expect(fixture.spawn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still reports a root exit once after an unconfirmed close', async () => {
    vi.useFakeTimers()
    const fixture = fakeChild()
    const managed = launch(fixture)
    const report = vi.fn()
    managed.onExit(report)
    const close = managed.close()
    await vi.advanceTimersByTimeAsync(150)
    await expect(close).resolves.toBe('unverifiable')
    fixture.child.emit('exit', 0, null)
    fixture.child.emit('close', 0, null)
    expect(report).toHaveBeenCalledOnce()
    await expect(managed.close()).resolves.toBe('exited')
  })

  it('requires error then close for a processless spawn to settle', async () => {
    const fixture = fakeChild(null)
    const managed = launch(fixture)
    fixture.child.emit('error', new Error('ENOENT'))
    expect(managed.rootVerdict).toBe('unverifiable')
    fixture.child.emit('close', null, null)
    expect(managed.processless).toBe(true)
    expect(managed.exited).toBe(false)
    await expect(managed.close()).resolves.toBe('exited')
  })

  it('does not turn a transport close with an existing pid into Claude exit proof', () => {
    const fixture = fakeChild()
    const managed = launch(fixture)
    fixture.child.emit('error', new Error('EPIPE'))
    fixture.child.emit('close', 0, null)
    expect(managed.exited).toBe(false)
    expect(managed.processless).toBe(false)
  })

  it('uses Windows tree teardown and still requires observed root exit', async () => {
    vi.useFakeTimers()
    const fixture = fakeChild()
    const managed = launch(fixture, 'win32')
    expect(managed.supervised).toBe(false)
    const first = managed.close()
    await vi.advanceTimersByTimeAsync(150)
    await expect(first).resolves.toBe('unverifiable')
    expect(mocks.windowsTree).toHaveBeenCalledWith(fixture.child.pid, {
      site: 'fixture-provider-teardown'
    })
    expect(fixture.child.kill).not.toHaveBeenCalledWith('SIGTERM')
    fixture.child.emit('exit', null, 'SIGKILL')
    await expect(managed.close()).resolves.toBe('exited')
  })

  it('preserves a caller requiring tree proof, including live and unverifiable descendants', async () => {
    const fixture = fakeChild()
    const managed = spawnManagedProviderProcess(
      { command: 'fixture-provider', args: [] },
      {
        spawnImpl: fixture.spawn,
        platform: 'darwin',
        site: 'fixture',
        policy: () => ({ gracefulExitMs: 100, forcedExitMs: 50, requireTreeExit: true })
      }
    )
    const proof = fakeTree()
    fixture.child.emit('exit', 0, null)
    await expect(managed.close(proof.tree)).resolves.toBe('unverifiable')
    proof.setVerdict('live')
    await expect(managed.close(proof.tree)).resolves.toBe('live')
    proof.setVerdict('exited')
    await expect(managed.close(proof.tree)).resolves.toBe('exited')
  })

  it('reports failed tree cleanup separately after observed root exit', async () => {
    vi.useFakeTimers()
    const fixture = fakeChild()
    const managed = launch(fixture, 'win32')
    mocks.windowsTree.mockImplementationOnce(async () => {
      fixture.child.emit('exit', null, 'SIGKILL')
      throw new Error('tree teardown unavailable')
    })
    const close = managed.close()
    await vi.advanceTimersByTimeAsync(150)
    await expect(close).resolves.toBe('exited')
    expect(managed.teardownUnproven).toBe(true)
  })

  it('keeps the cleanup diagnostic tied to the close that finished before a late root exit', async () => {
    vi.useFakeTimers()
    const fixture = fakeChild()
    const managed = launch(fixture, 'win32')
    mocks.windowsTree.mockRejectedValueOnce(new Error('tree teardown unavailable'))
    const close = managed.close()
    await vi.advanceTimersByTimeAsync(150)
    await expect(close).resolves.toBe('unverifiable')
    fixture.child.emit('exit', null, 'SIGKILL')
    await expect(managed.close()).resolves.toBe('exited')
    expect(managed.teardownUnproven).toBe(false)
  })

  it('lets a supervised caller signal immediately and waits its configured grace before forcing', async () => {
    vi.useFakeTimers()
    const fixture = fakeChild()
    const managed = spawnManagedProviderProcess(
      { command: 'fixture-provider', args: [] },
      {
        spawnImpl: fixture.spawn,
        platform: 'darwin',
        site: 'fixture',
        policy: () => ({ gracefulExitMs: 600, forcedExitMs: 50, signalSupervisorOnClose: true })
      }
    )
    fixture.child.kill.mockImplementation(() => {
      setTimeout(() => fixture.child.emit('exit', 0, 'SIGTERM'), 550)
      return true
    })
    const close = managed.close()
    await vi.advanceTimersByTimeAsync(549)
    expect(fixture.child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    expect(managed.exited).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(close).resolves.toBe('exited')
    expect(fixture.child.kill).not.toHaveBeenCalledWith('SIGKILL')
    expect(vi.getTimerCount()).toBe(0)
  })
})
