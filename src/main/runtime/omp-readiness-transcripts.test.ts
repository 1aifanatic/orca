import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { extractLastOscTitle } from '../../shared/osc-title-extraction'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function transcript(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.txt`), 'utf8')
}

describe('OMP 18.4.5 captured readiness', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each([
    ['omp-18-setup', 120, 40, false],
    ['omp-18-composer', 120, 40, true],
    ['omp-18-composer-narrow', 60, 24, true]
  ] as const)('%s at %sx%s has readiness %s', async (name, cols, rows, ready) => {
    const data = transcript(name)
    expect(data).toContain('\x1b[')
    expect(data).toContain('\r')
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: extractLastOscTitle(data) ?? 'OMP',
      foregroundProcess: 'omp',
      data,
      launchAgent: 'omp',
      size: { cols, rows }
    })
    const result = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 5_000 })
    const assertion = ready
      ? expect(result).resolves.toMatchObject({ satisfied: true })
      : expect(result).rejects.toThrow('timeout')
    await Promise.all([assertion, vi.advanceTimersByTimeAsync(5_000)])
  })

  it('does not accept the composer while its native title still says working', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'OMP',
      foregroundProcess: 'omp',
      data: transcript('omp-18-composer'),
      launchAgent: 'omp',
      size: { cols: 120, rows: 40 }
    })
    // Synthetic busy transition isolates the timer while preserving the captured composer grid.
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]0;π : capture-cwd\x07', Date.now())
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b[0m', Date.now())
    const result = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 5_000 })
    const assertion = expect(result).rejects.toThrow('timeout')
    await Promise.all([assertion, vi.advanceTimersByTimeAsync(5_000)])
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]0;π > capture-cwd\x07', Date.now())
    const idle = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 5_000 })
    const idleAssertion = expect(idle).resolves.toMatchObject({ satisfied: true })
    await Promise.all([idleAssertion, vi.advanceTimersByTimeAsync(5_000)])
  })
})
