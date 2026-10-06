import { setImmediate as waitForPoll } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProfileStateWriterRequest } from './profile-state-writer-protocol'
import { ProfileStateWriterSupervisor } from './profile-state-writer-supervisor'

const fixture = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  class Worker extends EventEmitter {
    static instances: Worker[] = []
    requests: ProfileStateWriterRequest[] = []
    terminate = vi.fn(() => new Promise<number>(() => {}))
    constructor() {
      super()
      Worker.instances.push(this)
    }
    postMessage(request: ProfileStateWriterRequest) {
      this.requests.push(request)
    }
  }
  return { Worker }
})
vi.mock('node:worker_threads', () => ({ Worker: fixture.Worker }))
vi.mock('./profile-state-writer-diagnostics', () => ({
  recordProfileStateWriterFault: vi.fn(),
  recordProfileStateWriterGrace: vi.fn(),
  recordProfileStateWriterTimeout: vi.fn(),
  recordProfileStateWriterRecovery: vi.fn()
}))

const supervisors: ProfileStateWriterSupervisor[] = []
const TIMEOUT_MS = 30_000

afterEach(async () => {
  for (const worker of fixture.Worker.instances.splice(0)) {
    worker.emit('exit', 1)
  }
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.close().catch(() => {})))
  vi.useRealTimers()
})

function workerAt(index: number) {
  const worker = fixture.Worker.instances[index]
  if (!worker) {
    throw new Error(`Missing worker ${index}`)
  }
  return worker
}

async function createSupervisor(initialize = true) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const onFailure = vi.fn()
  const clock = { now: 0 }
  const supervisor = new ProfileStateWriterSupervisor(
    { databasePath: 'unused.db', profileId: 'recovery-lifecycle', revision: 1 },
    { workerPath: 'unused.cjs', timeoutMs: TIMEOUT_MS, onFailure, clock: () => clock.now }
  )
  supervisors.push(supervisor)
  const original = workerAt(0)
  if (initialize) {
    original.emit('message', { id: 0, ok: true, revision: 1 })
    await supervisor.ready
  }
  return { supervisor, original, onFailure, clock }
}

async function startRecovery() {
  const context = await createSupervisor()
  const write = context.supervisor
    .write((writer) => writer.writeSerializedDomains([{ domain: 'ui', payload: '{}' }]))
    .catch((error: unknown) => error)
  context.original.emit('exit', 1)
  await waitForPoll()
  return { ...context, write, replacement: workerAt(1) }
}

it.each(['error', 'timeout'])(
  'keeps close pending until a replacement with a startup %s confirms exit',
  async (failure) => {
    const { supervisor, replacement, write, onFailure } = await startRecovery()
    if (failure === 'error') {
      replacement.emit('error', new Error('startup failed'))
    } else {
      vi.advanceTimersByTime(TIMEOUT_MS)
      await waitForPoll()
    }
    await expect(write).resolves.toMatchObject({ code: 'profile-state-writer-recovery-failed' })
    let closed = false
    const closing = supervisor.close().finally(() => (closed = true))
    await waitForPoll()
    expect(replacement.terminate).toHaveBeenCalledOnce()
    expect(closed).toBe(false)
    replacement.emit('exit', 1)
    await closing
    expect(onFailure).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  }
)

it('aborts the replacement still starting and waits for its exit', async () => {
  const { supervisor, replacement, write } = await startRecovery()
  let aborted = false
  const aborting = supervisor.abort().finally(() => (aborted = true))
  await waitForPoll()
  expect(replacement.terminate).toHaveBeenCalledOnce()
  expect(aborted).toBe(false)
  replacement.emit('exit', 1)
  await aborting
  await expect(write).resolves.toMatchObject({ outcome: 'indeterminate' })
  expect(vi.getTimerCount()).toBe(0)
})

it('refuses a replacement while the old thread has not confirmed exit', async () => {
  const { supervisor, original, onFailure } = await createSupervisor()
  const write = supervisor.write((writer) => writer.writeSerializedDomains([])).catch((e) => e)
  vi.advanceTimersByTime(TIMEOUT_MS)
  await waitForPoll()
  expect(original.terminate).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(TIMEOUT_MS)
  await waitForPoll()
  await expect(write).resolves.toMatchObject({
    code: 'profile-state-writer-exit-unconfirmed',
    outcome: 'indeterminate'
  })
  expect(fixture.Worker.instances).toHaveLength(1)
  expect(onFailure).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('answers a proven commit during close after the replacement exits', async () => {
  const { supervisor, replacement, write, onFailure } = await startRecovery()
  let closed = false
  const closing = supervisor.close().finally(() => (closed = true))
  replacement.emit('message', { id: 0, ok: true, revision: 2 })
  await waitForPoll()
  expect(replacement.requests).toEqual([{ command: 'close', id: 1 }])
  expect(closed).toBe(false)
  replacement.emit('message', { id: 1, ok: true, revision: 2 })
  replacement.emit('exit', 0)
  await closing
  await expect(write).resolves.toBeUndefined()
  expect(onFailure).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not recover an original writer that never acknowledged startup', async () => {
  const { supervisor, original } = await createSupervisor(false)
  original.emit('exit', 1)
  await expect(supervisor.ready).rejects.toMatchObject({ code: 'profile-state-writer-exit' })
  await waitForPoll()
  expect(fixture.Worker.instances).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('allows recovery again once the rolling window expires', async () => {
  const { supervisor, clock, onFailure } = await createSupervisor()
  for (let cycle = 0; cycle < 4; cycle += 1) {
    if (cycle === 3) {
      clock.now = 10 * 60_000
    }
    workerAt(cycle).emit('exit', 1)
    await waitForPoll()
    workerAt(cycle + 1).emit('message', { id: 0, ok: true, revision: 1 })
    await waitForPoll()
    expect(() => supervisor.assertWritable()).not.toThrow()
  }
  expect(fixture.Worker.instances).toHaveLength(5)
  expect(onFailure).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('gives a late exit wait extra time without starting another writer', async () => {
  const { supervisor, original, clock } = await createSupervisor()
  const write = supervisor.write((writer) => writer.writeSerializedDomains([]))
  vi.advanceTimersByTime(TIMEOUT_MS)
  await waitForPoll()
  clock.now += 13 * 60 * 60_000
  vi.advanceTimersByTime(TIMEOUT_MS)
  await waitForPoll()
  expect(fixture.Worker.instances).toHaveLength(1)
  original.emit('exit', 1)
  await waitForPoll()
  const replacement = workerAt(1)
  replacement.emit('message', { id: 0, ok: true, revision: 1 })
  await waitForPoll()
  expect(replacement.requests).toEqual([{ command: 'write-domains', replacements: [], id: 1 }])
  replacement.emit('message', { id: 1, ok: true, revision: 1 })
  await write
  expect(vi.getTimerCount()).toBe(0)
})
