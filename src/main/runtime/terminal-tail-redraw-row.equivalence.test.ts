import { describe, expect, it } from 'vitest'
import {
  eraseRetainedRow,
  retainedRow,
  retainedRowSnapshot,
  writeRetainedRow
} from './terminal-tail-redraw-row'

// Differential guard: the cached string/cell row must match the original one-character-at-a-time
// string row on every write, erase, and newline snapshot, including identical rewrites and
// trailing spaces/tabs.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The pre-cache row semantics: per-character string writes. */
class ReferenceRow {
  constructor(public text: string) {}

  write(column: number, run: string): void {
    for (const char of run.split('')) {
      if (column > this.text.length) {
        this.text += ' '.repeat(column - this.text.length)
      }
      this.text =
        column >= this.text.length
          ? `${this.text}${char}`
          : `${this.text.slice(0, column)}${char}${this.text.slice(column + 1)}`
      column += 1
    }
  }

  erase(mode: number, column: number): void {
    if (mode === 0) {
      this.text = this.text.slice(0, column)
    } else if (mode === 1) {
      const count = Math.min(column + 1, this.text.length)
      this.text = `${' '.repeat(count)}${this.text.slice(count)}`
    } else if (mode === 2) {
      this.text = ''
    }
  }

  snapshot(): string {
    return this.text.replace(/[ \t]+$/, '')
  }
}

function randomRun(rng: () => number, reference: string, column: number): string {
  const roll = rng()
  const length = 1 + Math.floor(rng() * 12)
  if (roll < 0.3 && column < reference.length) {
    // Identical rewrite, sometimes running past the row end.
    return reference.slice(column, column + length) || 'z'
  }
  const alphabet = roll < 0.6 ? ' \t' : 'ab \ty'
  let run = ''
  for (let index = 0; index < length; index += 1) {
    run += alphabet[Math.floor(rng() * alphabet.length)]
  }
  return run
}

function randomInitialRow(rng: () => number): string {
  const kinds = ['', 'panel', 'x'.repeat(30), `panel${' '.repeat(40)}`, `a\t \t${'\t'.repeat(9)}`]
  return kinds[Math.floor(rng() * kinds.length)]!
}

describe('retained terminal row equivalence', () => {
  it('matches per-character string rows across 3,000 randomized edit sequences', () => {
    const rng = mulberry32(0x26316)
    for (let sequence = 0; sequence < 3_000; sequence += 1) {
      const initial = randomInitialRow(rng)
      const row = retainedRow(initial, true)
      const reference = new ReferenceRow(initial)
      const ops: string[] = []
      for (let step = 0; step < 24; step += 1) {
        const width = reference.text.length
        const column = Math.floor(rng() * (width + 6))
        const roll = rng()
        if (roll < 0.55) {
          const run = randomRun(rng, reference.text, column)
          ops.push(`w${column}:${JSON.stringify(run)}`)
          reference.write(column, run)
          writeRetainedRow(row, column, `<${run}>`, 1, run.length + 1)
        } else if (roll < 0.75) {
          const mode = Math.floor(rng() * 4)
          ops.push(`e${mode}@${column}`)
          reference.erase(mode, column)
          eraseRetainedRow(row, mode, column)
        }
        // Newline snapshots interleave with edits, so cached snapshots must invalidate exactly.
        if (rng() < 0.5) {
          expect(retainedRowSnapshot(row), `${JSON.stringify(initial)} ${ops.join(' ')}`).toBe(
            reference.snapshot()
          )
        }
      }
      expect(retainedRowSnapshot(row), `${JSON.stringify(initial)} ${ops.join(' ')}`).toBe(
        reference.snapshot()
      )
    }
  })
})
