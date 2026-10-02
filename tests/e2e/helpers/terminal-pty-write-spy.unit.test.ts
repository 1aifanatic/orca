import type { ElectronApplication } from '@stablyai/playwright-test'
import * as electron from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { setTerminalPtyWriteDelay } from './terminal-pty-write-spy'

afterEach(() => vi.unstubAllGlobals())

it('sets and clears paste backpressure using the main-process evaluate argument', async () => {
  vi.stubGlobal('__terminalPtyWriteDelayMs', 0)
  const evaluate = vi.fn<ElectronApplication['evaluate']>()
  evaluate.mockImplementation(async (callback, delay) => {
    if (typeof callback !== 'function') {
      throw new Error('Expected a main-process evaluate callback')
    }
    return callback(electron, delay)
  })
  const app = { evaluate }

  if (!('__terminalPtyWriteDelayMs' in globalThis)) {
    throw new Error('Expected the stubbed PTY write delay')
  }

  await setTerminalPtyWriteDelay(app, 35)
  expect(globalThis.__terminalPtyWriteDelayMs).toBe(35)
  await setTerminalPtyWriteDelay(app, 0)
  expect(globalThis.__terminalPtyWriteDelayMs).toBe(0)
})
