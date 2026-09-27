// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installArrivalRecorder } from './sidebar-arrival-write-recorder'

/**
 * Validates the recorder before CI trusts it. happy-dom only moves scrollTop for the numeric
 * `scrollTo(x, y)` form and implements scrollTo over the scrollTop setter, so each numeric call also
 * reaches the setter hook. A real browser's scrollTo is native and should not nest; the nesting
 * assertions exist because this is where that behaviour is observable.
 */
describe('arrival write recorder', () => {
  const ATTRIBUTE = 'data-worktree-sidebar'
  let active: { stop: () => void } | null = null

  beforeEach(() => {
    document.body.innerHTML = ''
    installArrivalRecorder()
  })

  afterEach(() => {
    active?.stop()
    active = null
  })

  function sidebar(): HTMLElement {
    const element = document.createElement('div')
    element.setAttribute(ATTRIBUTE, '')
    document.body.append(element)
    return element
  }

  function recorder() {
    const created = window.__arrivalRecorder!.create(ATTRIBUTE, performance.now())
    active = created
    return created
  }

  function outer(log: ReturnType<ReturnType<typeof recorder>['log']>) {
    return log.writes.filter((write) => write.nestedInSeq === null)
  }

  it('captures a write to a replacement scroller before any sample sees it', () => {
    const first = sidebar()
    const probe = recorder()
    expect(probe.scroller()).toBe(first)
    first.remove()
    // The replacement is written to immediately, with no intervening scroller() call.
    const replacement = sidebar()
    replacement.scrollTo(0, 512)
    const log = probe.log()
    expect(log.totalWrites).toBe(1)
    expect(outer(log)[0]!.scrollerGeneration).toBe(2)
    expect(log.generationCount).toBe(2)
    expect(log.generations[1]!.observedBy).toBe('write')
    expect(log.generations[1]!.reason).toBe('replaced')
  })

  it('returns null rather than a detached node, and records the missing sample', () => {
    const first = sidebar()
    const probe = recorder()
    expect(probe.scroller()).toBe(first)
    first.remove()
    expect(probe.scroller()).toBeNull()
    probe.noteMissingSample()
    const log = probe.log()
    expect(log.missingSamples).toHaveLength(1)
    expect(log.missingSamples[0]!.reason).toBe('no-element')
    expect(log.generationCount).toBe(1)
  })

  it('records requested versus actual for every scroll entry point', () => {
    const element = sidebar()
    const probe = recorder()
    element.scrollTo({ top: 8939, behavior: 'smooth' })
    element.scroll({ top: 40 })
    element.scrollBy({ top: 10 })
    element.scrollTop = 1200
    const log = probe.log()
    expect(log.byKind).toMatchObject({ scrollTo: 1, scroll: 1, scrollBy: 1, 'scrollTop=': 1 })
    expect(log.totalWrites).toBe(4)
    const first = outer(log)[0]!
    expect(first.requestedTop).toBe(8939)
    expect(first.behavior).toBe('smooth')
    expect(first.argShape).toBe('options')
    expect(first.fromTop).toBe(0)
    const assignment = outer(log).find((write) => write.kind === 'scrollTop=')!
    expect(assignment.requestedTop).toBe(1200)
    expect(assignment.appliedTop).toBe(1200)
    expect(element.scrollTop).toBe(1200)
  })

  it('treats an unchanged immediate read-back as exactly that, not as a dropped write', () => {
    const element = sidebar()
    const probe = recorder()
    // The options form does not move happy-dom's offset, which is the same shape a real smooth
    // initiation takes: the immediate read-back is unchanged and the write is still live.
    element.scrollTo({ top: 8939, behavior: 'smooth' })
    const write = outer(probe.log())[0]!
    expect(write.immediateOffsetUnchanged).toBe(true)
    expect(write.appliedTop).toBe(write.fromTop)
    expect(write.threw).toBe(false)
    expect(probe.log().immediateOffsetUnchangedWrites).toBe(1)
    expect(Object.keys(write)).not.toContain('noOp')
    expect(Object.keys(write)).not.toContain('dropped')
  })

  it('preserves this, overloads and the return value, and ignores other elements', () => {
    const element = sidebar()
    const other = document.createElement('div')
    document.body.append(other)
    const probe = recorder()
    expect(element.scrollTo(0, 250)).toBeUndefined()
    expect(element.scrollTop).toBe(250)
    other.scrollTo(0, 99)
    other.scrollTop = 77
    expect(other.scrollTop).toBe(77)
    const log = probe.log()
    expect(log.totalWrites).toBe(1)
    expect(outer(log)[0]!.argShape).toBe('number,number')
    expect(outer(log)[0]!.appliedTop).toBe(250)
  })

  it('rethrows a native failure and marks the entry as thrown', () => {
    const element = sidebar()
    const failure = new Error('native scroll failure')
    const original = Element.prototype.scrollTo
    Object.defineProperty(Element.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: function () {
        throw failure
      }
    })
    try {
      const probe = recorder()
      expect(() => element.scrollTo({ top: 10 })).toThrow(failure)
      const log = probe.log()
      expect(log.threwWrites).toBe(1)
      const write = outer(log)[0]!
      expect(write.threw).toBe(true)
      expect(write.appliedTop).toBeNull()
      probe.stop()
      active = null
    } finally {
      Object.defineProperty(Element.prototype, 'scrollTo', {
        configurable: true,
        writable: true,
        value: original
      })
    }
  })

  it('keeps every sequence number unique across nested entries', () => {
    const element = sidebar()
    const probe = recorder()
    element.scrollTo(0, 10)
    element.scrollTo(0, 20)
    element.scrollTop = 30
    const log = probe.log()
    const seqs = log.writes.map((write) => write.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(log.totalWrites + log.nestedWrites).toBe(log.recordedEntries + log.truncatedEntries)
    expect(
      log.writes
        .filter((write) => write.nestedInSeq !== null)
        .every((write) => outer(log).some((parent) => parent.seq === write.nestedInSeq))
    ).toBe(true)
  })

  it('reports writes per sample through the cursor without double counting', () => {
    const element = sidebar()
    const probe = recorder()
    expect(probe.takeWriteCursor()).toEqual({ sinceLastSample: 0, lastSeq: null })
    element.scrollTo(0, 10)
    element.scrollTo(0, 20)
    expect(probe.takeWriteCursor().sinceLastSample).toBe(2)
    expect(probe.takeWriteCursor().sinceLastSample).toBe(0)
  })

  it('bounds the log while accounting for every entry', () => {
    const element = sidebar()
    const probe = recorder()
    for (let index = 0; index < 405; index++) {
      element.scrollTo(0, index)
    }
    const log = probe.log()
    expect(log.totalWrites).toBe(405)
    expect(log.recordedEntries).toBe(400)
    expect(log.recordedEntries + log.truncatedEntries).toBe(log.totalWrites + log.nestedWrites)
  })

  it('restores every prototype descriptor on stop', () => {
    const element = sidebar()
    const before = {
      scrollTo: Element.prototype.scrollTo,
      scroll: Element.prototype.scroll,
      scrollBy: Element.prototype.scrollBy,
      scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
    }
    const probe = recorder()
    expect(Element.prototype.scrollTo).not.toBe(before.scrollTo)
    probe.stop()
    active = null
    expect(Element.prototype.scrollTo).toBe(before.scrollTo)
    expect(Element.prototype.scroll).toBe(before.scroll)
    expect(Element.prototype.scrollBy).toBe(before.scrollBy)
    expect(Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')?.set).toBe(
      before.scrollTop?.set
    )
    element.scrollTo(0, 5)
    expect(probe.log().totalWrites).toBe(0)
  })
})
