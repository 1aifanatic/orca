/**
 * A command Orca launched has to show it is up before tui-idle may settle: a flagged agent
 * launch (`omp --thinking high`) is still that agent, and an unknown command has to paint.
 * Settling on the first quiet poll let the next prompt land in a TUI that was still booting.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'

const POLL_INTERVAL_MS = 2_000

async function launch(command: string | undefined, foregroundProcess: string) {
  const pane = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess,
    data: '',
    ...(command ? { command } : {})
  })
  vi.useFakeTimers()
  const settled = vi.fn()
  const wait = pane.runtime.waitForTerminal(pane.handle, {
    condition: 'tui-idle',
    timeoutMs: 60_000
  })
  wait.then(settled, () => {})
  const write = (chunk: string) => pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, Date.now())
  return { ...pane, wait, settled, write }
}

describe('tui-idle on a command Orca launched', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not settle a flagged agent launch that has painted nothing', async () => {
    const pane = await launch('omp --thinking high', 'omp')

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)

    expect(pane.settled).not.toHaveBeenCalled()
  })

  it('does not settle a flagged Codex launch on its shell echo alone', async () => {
    const pane = await launch('codex -c model_reasoning_effort="high"', 'codex')
    pane.write('\x1b]133;A\x07~/repo % codex -c model_reasoning_effort="high"\r\n\x1b]133;C\x07')

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)

    expect(pane.settled).not.toHaveBeenCalled()
  })

  it('waits for an unknown command to paint, then settles once it is quiet', async () => {
    const pane = await launch('my-tool --serve', 'my-tool')

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(pane.settled).not.toHaveBeenCalled()

    pane.write('\x1b]133;A\x07~/repo % my-tool --serve\r\n\x1b]133;C\x07')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(pane.settled).not.toHaveBeenCalled()

    pane.write('my-tool ready> ')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    await expect(pane.wait).resolves.toMatchObject({ satisfied: true })
  })

  it('settles vim once it has painted and gone quiet', async () => {
    const pane = await launch('vim README.md', 'vim')
    pane.write('\x1b]133;A\x07~/repo % vim README.md\r\n\x1b]133;C\x07')
    pane.write('\x1b[?1049h\x1b[H# README\r\n~\r\n~\r\n"README.md" 1L, 9B')

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)

    await expect(pane.wait).resolves.toMatchObject({ satisfied: true })
  })

  it('still settles an unidentified pane running a quiet non-agent process', async () => {
    const pane = await launch(undefined, 'less')

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)

    await expect(pane.wait).resolves.toMatchObject({ satisfied: true })
  })
})
