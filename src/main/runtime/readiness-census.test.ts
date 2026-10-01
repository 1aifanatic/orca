/**
 * The readiness census (STA-9098): today's tui-idle verdicts, pinned so a refactor of the readiness
 * rules can prove it changed none of them.
 *
 * - Transcripts (readiness-census-<family>.test.ts): every recorded agent PTY transcript is replayed
 *   chunk by chunk into a real runtime pane at its recorded grid, once with the agent known and once
 *   agent-unknown. Each frame records the ranked verdict the moment the chunk lands, the verdict had
 *   the stream then gone quiet, whether `terminal wait --for tui-idle` started there settles (at once
 *   or on its first poll tick), and the same on a clockless (restored or adopted) pane.
 * - Synthetic (readiness-census-synthetic-*.test.ts): all 43 TuiAgents under a bounded matrix of
 *   title, first-party status, screen trust, foreground process and output clock
 *   (readiness-census-synthetic-matrix.ts says which cross-product and why).
 *
 * Baselines live in __fixtures__/readiness-census/, run-length encoded per frame. Any difference
 * fails with the agent, pane and frames that changed. If the change is intended, regenerate with
 *
 *   UPDATE_READINESS_CENSUS=1 pnpm test src/main/runtime/readiness-census
 *
 * and review the JSON diff.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeCensusDiff, runLengthDecode, runLengthEncode } from './readiness-census-baseline'
import { syntheticCases } from './readiness-census-synthetic-matrix'
import { CENSUS_AGENTS } from './readiness-census-synthetic-suite'
import {
  CENSUS_FAMILIES,
  censusTranscripts,
  FIXTURE_NAMES
} from './readiness-census-transcript-catalog'

const FIXTURES = join(__dirname, '__fixtures__')

function transcriptFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.txt'))
    .map((file) => file.slice(0, -'.txt'.length))
}

describe('readiness census coverage', () => {
  const replayed = CENSUS_FAMILIES.flatMap((family) =>
    censusTranscripts(family).map((transcript) => transcript.name)
  )
  // Why: a long recording's pane groups replay as `<name>@agent` and `<name>@unknown`.
  const replayedFixtures = [...new Set(replayed.map((name) => name.split('@')[0]))]

  it('replays every recorded transcript exactly once', () => {
    const recorded = [
      ...transcriptFiles(FIXTURES),
      ...transcriptFiles(join(__dirname, '..', 'daemon', '__fixtures__', 'pty-transcripts')).map(
        (name) => `daemon/${name}`
      ),
      'grok/startup',
      'grok/inline-startup'
    ]
    expect(replayedFixtures.toSorted()).toEqual(recorded.toSorted())
    expect(new Set(replayed).size).toBe(replayed.length)
    expect(FIXTURE_NAMES.every((name) => replayedFixtures.includes(name))).toBe(true)
  })

  it('covers all 43 agents in the synthetic matrix', () => {
    expect(CENSUS_AGENTS).toHaveLength(43)
    for (const agent of CENSUS_AGENTS) {
      expect(syntheticCases(agent).length).toBeGreaterThan(30)
    }
  })

  it('keeps no baseline for a subject that is no longer replayed', () => {
    const subjects = new Set([
      ...replayed.map((name) => `transcript--${name.replaceAll('/', '--')}.json`),
      ...CENSUS_AGENTS.map((agent) => `synthetic--${agent}.json`)
    ])
    const stored = readdirSync(join(FIXTURES, 'readiness-census'))
    expect(stored.filter((file) => !subjects.has(file))).toEqual([])
    expect([...subjects].filter((file) => !stored.includes(file))).toEqual([])
  })
})

describe('readiness census baseline encoding', () => {
  it('round-trips frames through run-length lines', () => {
    const frames = ['a', 'a', 'b', 'a', 'a', 'a']
    expect(runLengthEncode(frames)).toEqual(['0-1: a', '2: b', '3-5: a'])
    expect(runLengthDecode(runLengthEncode(frames))).toEqual(frames)
  })

  it('names the pane and frames that changed', () => {
    const diff = describeCensusDiff(
      'transcript/codex',
      { 'agent:clocked': ['x', 'x', 'y', 'y', 'z'] },
      { 'agent:clocked': ['x', 'w', 'w', 'y', 'z'] }
    )
    expect(diff).toEqual([
      'transcript/codex agent:clocked [1]:\n    was: x\n    now: w',
      'transcript/codex agent:clocked [2]:\n    was: y\n    now: w'
    ])
  })
})
