import { describe, expect, it } from 'vitest'
import { createPtyOutputPacer } from './bun-pty-output-pacer'

function harness(options: {
  sliceChars?: number
  turnBudgetMs?: number
  maxPendingChars?: number
}) {
  let clock = 0
  const tasks: (() => void)[] = []
  const delivered: string[] = []
  const pacer = createPtyOutputPacer(
    (data) => {
      delivered.push(data)
      // Each delivery costs 1 ms of the loop turn.
      clock += 1
    },
    { ...options, now: () => clock, schedule: (task) => tasks.push(task) }
  )
  const runTurn = (): void => {
    for (const task of tasks.splice(0)) {
      task()
    }
  }
  return { pacer, delivered, tasks, runTurn }
}

describe('PTY output pacer', () => {
  it('delivers small output synchronously', () => {
    const h = harness({})
    h.pacer.push('prompt$ ')
    expect(h.delivered).toEqual(['prompt$ '])
  })

  it('yields after the turn budget and resumes on the next turn in order', () => {
    const h = harness({ sliceChars: 4, turnBudgetMs: 2 })
    h.pacer.push('aaaabbbbccccdddd')
    h.pacer.push('eeee')
    expect(h.delivered).toEqual(['aaaa', 'bbbb'])
    h.runTurn()
    expect(h.delivered.join('')).toBe('aaaabbbbccccdddd'.slice(0, 16))
    h.runTurn()
    expect(h.delivered.join('')).toBe('aaaabbbbccccddddeeee')
  })

  it('flushes everything queued, in order, before exit', () => {
    const h = harness({ sliceChars: 4, turnBudgetMs: 1 })
    h.pacer.push('abcdefghij')
    h.pacer.flush()
    expect(h.delivered.join('')).toBe('abcdefghij')
    h.runTurn()
    expect(h.delivered.join('')).toBe('abcdefghij')
  })

  it('stops deferring once the backlog exceeds its bound', () => {
    const h = harness({ sliceChars: 2, turnBudgetMs: 1, maxPendingChars: 6 })
    h.pacer.push('aabbcc')
    expect(h.delivered).toEqual(['aa'])
    // 4 queued + 3 new exceeds the 6-char bound, so everything is delivered now.
    h.pacer.push('ddd')
    expect(h.delivered.join('')).toBe('aabbccddd')
  })

  it('never splits a surrogate pair across slices', () => {
    const h = harness({ sliceChars: 2, turnBudgetMs: 100 })
    h.pacer.push('a😀b')
    expect(h.delivered).toEqual(['a', '😀', 'b'])
  })
})
