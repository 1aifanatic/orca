// One census suite per transcript family; see readiness-census-codex.test.ts for what it pins.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { checkCensusBaseline } from './readiness-census-baseline'
import { censusTranscripts, type CensusFamily } from './readiness-census-transcript-catalog'
import { replayCensusTranscript } from './readiness-census-transcript-replay'

// Why per transcript: the longest replays take several seconds under full-suite load.
const TRANSCRIPT_TIMEOUT_MS = 120_000

export function describeTranscriptCensus(family: CensusFamily): void {
  describe(`readiness census: ${family} transcripts`, () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    beforeAll(() => {
      // Why darwin for every recording: verdicts must not depend on the CI host, and all but one
      // capture (a Cline Windows startup, whose screen carries no platform branch) ran on POSIX.
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      // Why only these: xterm's write queue runs on real setTimeout, while the clock and the idle
      // poll's shared interval must be stepped by the census itself.
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    })
    afterAll(() => {
      vi.useRealTimers()
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    })

    it.each(censusTranscripts(family).map((transcript) => [transcript.name, transcript] as const))(
      '%s',
      async (_name, transcript) => {
        const frames = await replayCensusTranscript(transcript)
        const diff = checkCensusBaseline(
          `transcript/${transcript.name}`,
          `${transcript.agent ?? 'non-agent'} recording at ${transcript.cols}x${transcript.rows}, one entry per replayed chunk`,
          frames
        )
        expect(diff).toBe('')
      },
      TRANSCRIPT_TIMEOUT_MS
    )
  })
}
