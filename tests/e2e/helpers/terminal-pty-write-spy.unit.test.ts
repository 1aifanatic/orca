import { afterEach, expect, it, vi } from 'vitest'
import { setTerminalPtyWriteDelay } from './terminal-pty-write-spy'

afterEach(() => vi.unstubAllGlobals())

it('sets and clears paste backpressure using the main-process evaluate argument', async () => {
  let observedDelayMs = 0
  vi.stubGlobal('__terminalPtyWriteDelayMs', 0)
  Object.defineProperty(globalThis, '__terminalPtyWriteDelayMs', {
    configurable: true,
    get: () => observedDelayMs,
    set: (delayMs: number) => {
      observedDelayMs = delayMs
    }
  })
  const evaluate = vi.fn()
  evaluate.mockImplementation(
    (callback: (electron: undefined, argument: number) => void, delay: number) =>
      callback(undefined, delay)
  )
  const app = { evaluate }

  await setTerminalPtyWriteDelay(app, 35)
  expect(observedDelayMs).toBe(35)
  await setTerminalPtyWriteDelay(app, 0)
  expect(observedDelayMs).toBe(0)
})
