import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { openPathMock } = vi.hoisted(() => ({ openPathMock: vi.fn() }))

vi.mock('electron', () => ({ shell: { openPath: openPathMock } }))

import {
  LINUX_OPEN_PATH_SETTLE_BOUND_MS,
  openPathWithSystemDefault
} from './system-default-open-path'

describe('openPathWithSystemDefault', () => {
  let platformDescriptor: PropertyDescriptor | undefined

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { configurable: true, value })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    openPathMock.mockReset()
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  })

  afterEach(() => {
    vi.useRealTimers()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('treats a never-settling Linux open as launched after the bound', async () => {
    setPlatform('linux')
    openPathMock.mockReturnValue(new Promise<string>(() => {}))
    let settled: string | undefined
    void openPathWithSystemDefault('/tmp/file.txt').then((value) => {
      settled = value
    })

    await vi.advanceTimersByTimeAsync(LINUX_OPEN_PATH_SETTLE_BOUND_MS - 1)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe('')
  })

  it('keeps Linux launcher errors and rejections that settle before the bound', async () => {
    setPlatform('linux')
    openPathMock.mockResolvedValueOnce('no default app')
    await expect(openPathWithSystemDefault('/tmp/a')).resolves.toBe('no default app')

    openPathMock.mockRejectedValueOnce(new Error('launcher unavailable'))
    await expect(openPathWithSystemDefault('/tmp/b')).rejects.toThrow('launcher unavailable')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['darwin', 'win32'] as const)('waits for the real result on %s', async (platform) => {
    setPlatform(platform)
    let finish: (value: string) => void = () => {}
    openPathMock.mockReturnValue(new Promise<string>((resolve) => (finish = resolve)))
    let settled: string | undefined
    void openPathWithSystemDefault('/tmp/file.txt').then((value) => {
      settled = value
    })

    await vi.advanceTimersByTimeAsync(LINUX_OPEN_PATH_SETTLE_BOUND_MS * 10)
    expect(settled).toBeUndefined()
    finish('failed')
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe('failed')
  })
})
