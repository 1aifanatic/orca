import { expect } from 'vitest'
import { resetRetainedRowWork, retainedRowWork } from './terminal-tail-redraw-row'

const ESC = '\x1b'

export const REVISIT_ROW_WIDTHS = [1_000, 4_000, 16_000, 64_000, 128_000]
/** 0 is a cursor-only revisit; 32/33 straddle the old string-to-cells switch. */
export const REVISIT_EDITS_PER_NEWLINE = [0, 1, 32, 33, 100]
export const REVISIT_TRAILING = ['none', 'spaces', 'tabs'] as const

export type RowRevisitCase = {
  width: number
  edits: number
  trailing: (typeof REVISIT_TRAILING)[number]
  /** Whether each revisit writes different characters than the last. */
  changing: boolean
}

function wideRow({ width, trailing }: RowRevisitCase): string {
  if (trailing === 'none') {
    return 'x'.repeat(width)
  }
  return `panel${(trailing === 'spaces' ? ' ' : '\t').repeat(width - 5)}`
}

/** Paint one wide row, then revisit it with cursor-up, `edits` short writes, and newline. */
export function rowRevisitChunk(rowCase: RowRevisitCase, revisits: number): string {
  const visits: string[] = []
  for (let visit = 0; visit < revisits; visit += 1) {
    const char = rowCase.changing ? String.fromCharCode(0x61 + (visit % 26)) : 'y'
    visits.push(`${ESC}[1A${`\r${char}`.repeat(rowCase.edits)}\n`)
  }
  return `${ESC}[1A\r${wideRow(rowCase)}\n${visits.join('')}`
}

/** Characters touched by split, join, trailing-whitespace scans and row string building. */
export function measureRowWork(run: () => void): number {
  resetRetainedRowWork()
  run()
  return (
    retainedRowWork.split + retainedRowWork.join + retainedRowWork.trimScan + retainedRowWork.build
  )
}

export function rowRevisitCases(): RowRevisitCase[] {
  return REVISIT_ROW_WIDTHS.flatMap((width) =>
    REVISIT_EDITS_PER_NEWLINE.flatMap((edits) =>
      REVISIT_TRAILING.flatMap((trailing) =>
        (edits === 0 ? [false] : [false, true]).map((changing) => ({
          width,
          edits,
          trailing,
          changing
        }))
      )
    )
  )
}

/**
 * Asserts O(bytes + changed snapshots x width): an unchanged revisit adds no row work, and a
 * changing one adds at most a row-width snapshot. `models` is how many tails one chunk updates.
 */
export function expectLinearRevisitWork(
  feed: (text: string) => void,
  { revisits, models = 1 }: { revisits: number; models?: number }
): void {
  for (const rowCase of rowRevisitCases()) {
    const once = rowRevisitChunk(rowCase, revisits)
    const twice = rowRevisitChunk(rowCase, revisits * 2)
    const workOnce = measureRowWork(() => feed(once))
    const split = retainedRowWork.split
    const workTwice = measureRowWork(() => feed(twice))
    const label = JSON.stringify(rowCase)
    // Each model splits a row at most once per chunk.
    expect(split, label).toBeLessThanOrEqual(models * rowCase.width)
    const changedSnapshots = rowCase.changing ? revisits : 1
    expect(workOnce, label).toBeLessThanOrEqual(
      models * (2 * once.length + 4 * rowCase.width + changedSnapshots * rowCase.width)
    )
    const addedBytes = twice.length - once.length
    const addedWork = workTwice - workOnce
    expect(addedWork, label).toBeLessThanOrEqual(
      models * (2 * addedBytes + (rowCase.changing ? revisits * rowCase.width : 0))
    )
  }
}
