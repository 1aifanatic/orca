import { describe, expect, it } from 'vitest'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import { buildRestoredTerminalTailSeed } from './terminal-tail-restore-seed'
import {
  expectLinearRevisitWork,
  measureRowWork,
  rowRevisitChunk
} from './terminal-tail-redraw-work-test-harness'

// #11315: a chunk's row work must be O(bytes + changed rows x width); unchanged revisits are O(1).

const ESC = '\x1b'

describe('terminal tail redraw row work', () => {
  it('stays linear across the revisit matrix when seeding a restored tail', () => {
    expectLinearRevisitWork((text) => buildRestoredTerminalTailSeed(text), { revisits: 150 })
  })

  it('stays linear across the revisit matrix on the append path', () => {
    expectLinearRevisitWork((text) => appendNormalizedToTailBuffer([], '', text, null), {
      revisits: 150
    })
  })

  it('splits and joins a wide row once when every revisit repeats 33 identical edits', () => {
    // Astra round-2 repro: newline reset the row, so each revisit re-split and re-joined it.
    const text = `${ESC}[1A\r${'x'.repeat(128_000)}\n${`${ESC}[1A${'\ry'.repeat(33)}\n`.repeat(1_500)}`
    let lines: string[] | undefined
    const work = measureRowWork(() => {
      lines = buildRestoredTerminalTailSeed(text)?.lines
    })
    expect(work).toBeLessThan(4 * 128_000)
    expect(lines).toEqual([`y${'x'.repeat(127_999)}`])
  })

  it('does not rescan trailing whitespace on cursor-only revisits', () => {
    // Astra round-2 repro: each newline re-trimmed 128k trailing spaces.
    const text = `${ESC}[1A\rpanel${' '.repeat(127_995)}\n${`${ESC}[1A\n`.repeat(20_000)}`
    let lines: string[] | undefined
    const work = measureRowWork(() => {
      lines = buildRestoredTerminalTailSeed(text)?.lines
    })
    expect(work).toBeLessThan(2 * 128_000)
    expect(lines).toEqual(['panel'])
  })

  it('keeps the revisit fixture output exact', () => {
    const changing = rowRevisitChunk({ width: 40, edits: 3, trailing: 'tabs', changing: true }, 27)
    expect(buildRestoredTerminalTailSeed(changing)?.lines).toEqual(['aanel'])
    const unchanged = rowRevisitChunk(
      { width: 40, edits: 33, trailing: 'spaces', changing: false },
      5
    )
    expect(buildRestoredTerminalTailSeed(unchanged)?.lines).toEqual(['yanel'])
  })
})
