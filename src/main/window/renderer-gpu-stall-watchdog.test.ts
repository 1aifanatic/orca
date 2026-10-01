import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: vi.fn()
}))

import {
  createRendererGpuStallWatchdog,
  RENDERER_GPU_STALL_MAX_KILLS,
  RENDERER_GPU_STALL_PING_INTERVAL_MS,
  RENDERER_GPU_STALL_TIMEOUT_MS
} from './renderer-gpu-stall-watchdog'

function createHarness(canPing: () => boolean = () => true) {
  let clock = 1_000
  let answer: (() => void) | null = null
  const deps = {
    pingRenderer: vi.fn(() => new Promise<void>((resolve) => (answer = resolve))),
    canPing: vi.fn(canPing),
    readRendererCpuSeconds: vi.fn((): number | null => 0),
    readGpuPids: vi.fn(() => [4242]),
    killProcess: vi.fn(),
    onGpuKilled: vi.fn(),
    now: () => clock
  }
  const watchdog = createRendererGpuStallWatchdog(deps)
  const advance = (ms: number): void => {
    for (let elapsed = 0; elapsed < ms; elapsed += RENDERER_GPU_STALL_PING_INTERVAL_MS) {
      clock += RENDERER_GPU_STALL_PING_INTERVAL_MS
      watchdog.tick()
    }
  }
  const advanceAnswering = async (ms: number): Promise<void> => {
    for (let elapsed = 0; elapsed < ms; elapsed += RENDERER_GPU_STALL_PING_INTERVAL_MS) {
      clock += RENDERER_GPU_STALL_PING_INTERVAL_MS
      watchdog.tick()
      await Promise.resolve()
    }
  }
  const sleep = (ms: number): void => {
    clock += ms
    watchdog.tick()
  }
  return {
    deps,
    watchdog,
    advance,
    advanceAnswering,
    sleep,
    now: () => clock,
    answer: () => answer?.()
  }
}

describe('renderer GPU stall watchdog', () => {
  it('kills the GPU process when the renderer stops answering while idle', () => {
    const { deps, advance } = createHarness()
    advance(RENDERER_GPU_STALL_PING_INTERVAL_MS + RENDERER_GPU_STALL_TIMEOUT_MS)
    expect(deps.killProcess).toHaveBeenCalledWith(4242)
    expect(deps.onGpuKilled).toHaveBeenCalledTimes(1)
  })

  it('leaves the GPU alone while the renderer answers', async () => {
    const harness = createHarness()
    for (let round = 0; round < 10; round += 1) {
      harness.advance(RENDERER_GPU_STALL_PING_INTERVAL_MS)
      harness.answer()
      await Promise.resolve()
    }
    expect(harness.deps.pingRenderer.mock.calls.length).toBeGreaterThan(1)
    expect(harness.deps.killProcess).not.toHaveBeenCalled()
  })

  it('does not kill the GPU when the renderer is busy running JS', () => {
    const harness = createHarness()
    const { deps, advance } = harness
    deps.readRendererCpuSeconds.mockImplementation(() => harness.now() / 1_000)
    advance(RENDERER_GPU_STALL_TIMEOUT_MS * 3)
    expect(deps.killProcess).not.toHaveBeenCalled()
  })

  it('kills a wedged replacement, then stops at the kill budget', () => {
    const { deps, advance } = createHarness()
    advance(RENDERER_GPU_STALL_TIMEOUT_MS * (RENDERER_GPU_STALL_MAX_KILLS + 3))
    expect(deps.killProcess).toHaveBeenCalledTimes(RENDERER_GPU_STALL_MAX_KILLS)
  })

  it('discards a ping that spanned an OS sleep', () => {
    const { deps, advance, sleep } = createHarness()
    advance(RENDERER_GPU_STALL_PING_INTERVAL_MS)
    sleep(RENDERER_GPU_STALL_TIMEOUT_MS * 10)
    advance(RENDERER_GPU_STALL_TIMEOUT_MS)
    expect(deps.killProcess).not.toHaveBeenCalled()
  })

  it('discards a ping while the renderer cannot be pinged', () => {
    let pingable = true
    const { deps, advance } = createHarness(() => pingable)
    advance(RENDERER_GPU_STALL_PING_INTERVAL_MS)
    pingable = false
    advance(RENDERER_GPU_STALL_TIMEOUT_MS * 2)
    pingable = true
    advance(RENDERER_GPU_STALL_TIMEOUT_MS)
    expect(deps.killProcess).not.toHaveBeenCalled()
  })
  it('drops a ping lost to a renderer reload instead of killing a healthy GPU', async () => {
    const { deps, watchdog, advance, advanceAnswering } = createHarness()
    advance(RENDERER_GPU_STALL_PING_INTERVAL_MS)
    // The reload orphans the pending ping; it never settles.
    watchdog.reset()
    deps.pingRenderer.mockImplementation(() => Promise.resolve())
    await advanceAnswering(RENDERER_GPU_STALL_TIMEOUT_MS * 4)
    expect(deps.killProcess).not.toHaveBeenCalled()
  })

  it('sends a fresh ping after a kill instead of re-arming the lost one', async () => {
    const { deps, advance, advanceAnswering } = createHarness()
    advance(RENDERER_GPU_STALL_TIMEOUT_MS)
    // The first ping is lost for good; the recovered renderer answers new ones.
    deps.pingRenderer.mockImplementation(() => Promise.resolve())
    await advanceAnswering(RENDERER_GPU_STALL_TIMEOUT_MS * 4)
    expect(deps.killProcess).toHaveBeenCalledTimes(1)
  })
})
