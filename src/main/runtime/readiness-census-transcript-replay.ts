// Replays one recorded transcript into runtime panes, chunk by chunk, recording each frame's verdicts.
import { vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import {
  asClocklessPane,
  CENSUS_QUIESCENCE_MS,
  evaluatePaneVerdict,
  probePaneWait
} from './readiness-census-pane-probe'
import type { CensusTranscript } from './readiness-census-transcript-catalog'

/** Per pane, one observation string per frame. */
export type CensusPaneFrames = Record<string, string[]>

// Why 50 ms: at WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS the runtime's blocked scan runs inline rather
// than on a wall-clock timer, and 50 ms x the longest transcript stays far inside the 30-minute
// first-party status freshness window.
const FRAME_MS = 50
const BASE_TIME_MS = Date.UTC(2026, 0, 1)

/**
 * Each frame records, for a pane that knows its agent and for an agent-unknown pane:
 * - clocked: `now` (the verdict the moment the chunk lands), `quiet` (the verdict had the stream
 *   stopped there for the quiescence window) and `wait` (a tui-idle wait started at that quiet point);
 * - clockless: the same screen and tail on a pane with no output clock (restored or adopted).
 */
export async function replayCensusTranscript(
  transcript: CensusTranscript
): Promise<CensusPaneFrames> {
  const frames: CensusPaneFrames = {}
  const agents = transcript.agent ? [transcript.agent, null] : [null]
  for (const agent of agents) {
    if (transcript.panes && transcript.panes !== (agent ? 'agent' : 'unknown')) {
      continue
    }
    const prefix = agent ? 'agent' : 'unknown'
    const clocked: string[] = []
    const clockless: string[] = []
    await replayIntoPane(transcript, agent, clocked, clockless)
    frames[`${prefix}:clocked`] = clocked
    frames[`${prefix}:clockless`] = clockless
  }
  return frames
}

async function replayIntoPane(
  transcript: CensusTranscript,
  agent: CensusTranscript['agent'],
  clocked: string[],
  clockless: string[]
): Promise<void> {
  vi.setSystemTime(BASE_TIME_MS)
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: transcript.foregroundProcess,
    data: '',
    ...(agent ? { launchAgent: agent } : {}),
    size: { cols: transcript.cols, rows: transcript.rows }
  })
  for (const [index, chunk] of transcript.chunks().entries()) {
    const at = BASE_TIME_MS + (index + 1) * FRAME_MS
    // Why back in time after the previous frame's quiet probe: each frame is a branch point, and
    // a clock that kept advancing would age first-party statuses past their freshness window.
    vi.setSystemTime(at)
    let painted: Promise<void> = Promise.resolve()
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, at, chunk.length, false, (completion) => {
      painted = completion
    })
    await painted
    const now = evaluatePaneVerdict(runtime, handle)
    vi.setSystemTime(at + CENSUS_QUIESCENCE_MS)
    const quiet = evaluatePaneVerdict(runtime, handle)
    const wait = await probePaneWait(runtime, handle)
    clocked.push(`now=${now} quiet=${quiet} wait=${wait}`)
    const unclocked = await asClocklessPane(runtime, handle, TRANSCRIPT_PANE_PTY_ID, async () => {
      const verdict = evaluatePaneVerdict(runtime, handle)
      return `verdict=${verdict} wait=${await probePaneWait(runtime, handle)}`
    })
    clockless.push(unclocked)
  }
}
