/**
 * Diagnostic-only scroll-write recorder for the child-400 arrival probe.
 *
 * `installArrivalRecorder` is passed to `page.evaluate`, so it must stay self-contained: no imports,
 * no module-scope references. It exposes `window.__arrivalRecorder.create(...)`.
 *
 * Hooks live on `Element.prototype` and match the sidebar by attribute at call time, following the
 * proven prototype-level recorder shape. Per-node hooks installed at sample time cannot see writes to
 * a replacement scroller that arrive before the next sample, which is exactly when the initial reveal
 * write lands. Native `this`, argument overloads, return values and thrown errors pass through
 * unchanged, and every descriptor is restored on stop.
 */

export type ArrivalWriteKind = 'scrollTo' | 'scroll' | 'scrollBy' | 'scrollTop='

export type ArrivalWrite = {
  /** Unique across every recorded entry, nested included, so sequences never collide. */
  seq: number
  timeMs: number
  kind: ArrivalWriteKind
  scrollerGeneration: number
  fromTop: number
  requestedTop: number | null
  /** Offset read immediately after the call returned; null when the call threw. */
  appliedTop: number | null
  behavior: string | null
  /** Raw argument shape, so scrollTo(x, y) is distinguishable from an options call. */
  argShape: string
  /**
   * The immediate read-back equalled the offset before the call. For a smooth scroll this is the
   * NORMAL initiation result and says nothing about the write being dropped or cancelled.
   */
  immediateOffsetUnchanged: boolean
  threw: boolean
  /** Seq of the enclosing entry when one call reached a second hook; null for a top-level write. */
  nestedInSeq: number | null
  stack: string[]
}

export type ArrivalScrollerGeneration = {
  generation: number
  timeMs: number
  scrollHeight: number
  clientHeight: number
  scrollTop: number
  reason: 'initial' | 'replaced'
  /** 'write' when a write revealed the node before any sample did. */
  observedBy: 'write' | 'sample'
}

export type ArrivalMissingSample = {
  timeMs: number
  reason: 'no-element'
}

export type ArrivalWriteLog = {
  writes: ArrivalWrite[]
  generations: ArrivalScrollerGeneration[]
  missingSamples: ArrivalMissingSample[]
  /** Top-level writes. Nested entries are counted separately and never folded in here. */
  totalWrites: number
  nestedWrites: number
  recordedEntries: number
  /** Entries the bounded log could not keep. Not a statement about any write being cancelled. */
  truncatedEntries: number
  immediateOffsetUnchangedWrites: number
  threwWrites: number
  byKind: Record<string, number>
  smoothWrites: number
  generationCount: number
}

export type ArrivalRecorder = {
  /** Live scroller, or null. Never returns a detached node. */
  scroller: () => HTMLElement | null
  takeWriteCursor: () => { sinceLastSample: number; lastSeq: number | null }
  noteMissingSample: () => void
  log: () => ArrivalWriteLog
  stop: () => void
}

export type ArrivalRecorderApi = {
  create: (attribute: string, startedAt: number) => ArrivalRecorder
}

declare global {
  interface Window {
    __arrivalRecorder?: ArrivalRecorderApi
  }
}

export function installArrivalRecorder(): void {
  const MAX_RECORDED_ENTRIES = 400
  const MAX_STACK_FRAMES = 6
  const MAX_STACK_FRAME_CHARS = 160

  const captureStack = (): string[] => {
    const raw = new Error('arrival-probe-write').stack
    if (!raw) {
      return []
    }
    return raw
      .split('\n')
      .slice(2, 2 + MAX_STACK_FRAMES)
      .map((frame) => frame.trim().slice(0, MAX_STACK_FRAME_CHARS))
  }

  const create = (attribute: string, startedAt: number): ArrivalRecorder => {
    const selector = `[${attribute}]`
    const writes: ArrivalWrite[] = []
    const generations: ArrivalScrollerGeneration[] = []
    const missingSamples: ArrivalMissingSample[] = []
    const byKind: Record<string, number> = {}
    let recordSeq = 0
    let totalWrites = 0
    let nestedWrites = 0
    let truncatedEntries = 0
    let immediateOffsetUnchangedWrites = 0
    let threwWrites = 0
    let smoothWrites = 0
    let cursorSeenWrites = 0
    let generation = 0
    let known: HTMLElement | null = null
    let depth = 0
    let currentOuterSeq: number | null = null
    const now = () => performance.now() - startedAt

    const prototype = Element.prototype
    const scrollTopDescriptor = Object.getOwnPropertyDescriptor(prototype, 'scrollTop')
    const readTop = (element: Element): number => {
      const get = scrollTopDescriptor?.get
      return get ? get.call(element) : 0
    }

    const noteGeneration = (element: HTMLElement, observedBy: 'write' | 'sample') => {
      generation++
      known = element
      generations.push({
        generation,
        timeMs: now(),
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        scrollTop: readTop(element),
        reason: generation === 1 ? 'initial' : 'replaced',
        observedBy
      })
    }

    // O(1) attribute test, so a replacement scroller is matched on its very first write.
    const asSidebar = (element: Element): HTMLElement | null => {
      if (!(element instanceof HTMLElement) || !element.hasAttribute(attribute)) {
        return null
      }
      if (element !== known) {
        noteGeneration(element, 'write')
      }
      return element
    }

    const begin = (): { seq: number; nestedInSeq: number | null } => {
      depth++
      recordSeq++
      if (depth > 1) {
        nestedWrites++
        return { seq: recordSeq, nestedInSeq: currentOuterSeq }
      }
      totalWrites++
      currentOuterSeq = recordSeq
      return { seq: recordSeq, nestedInSeq: null }
    }

    const push = (entry: ArrivalWrite) => {
      if (entry.nestedInSeq === null) {
        byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
        if (entry.behavior === 'smooth') {
          smoothWrites++
        }
        if (entry.immediateOffsetUnchanged) {
          immediateOffsetUnchangedWrites++
        }
        if (entry.threw) {
          threwWrites++
        }
      }
      if (writes.length >= MAX_RECORDED_ENTRIES) {
        truncatedEntries++
        return
      }
      writes.push(entry)
    }

    const readArgs = (args: unknown[]): { top: number | null; behavior: string | null; shape: string } => {
      const first = args[0]
      if (typeof first === 'object' && first !== null) {
        const options: { top?: unknown; behavior?: unknown } = first
        return {
          top: typeof options.top === 'number' ? options.top : null,
          behavior: typeof options.behavior === 'string' ? options.behavior : null,
          shape: 'options'
        }
      }
      if (typeof first === 'number') {
        return { top: typeof args[1] === 'number' ? args[1] : null, behavior: null, shape: 'number,number' }
      }
      return { top: null, behavior: null, shape: args.length === 0 ? 'none' : 'other' }
    }

    const restores: (() => void)[] = []
    const methodNames = ['scrollTo', 'scroll', 'scrollBy'] as const

    for (const name of methodNames) {
      const methodDescriptor = Object.getOwnPropertyDescriptor(prototype, name)
      const original = prototype[name]
      const patched = function (this: Element, ...args: unknown[]): void {
        const element = asSidebar(this)
        if (!element) {
          return Reflect.apply(original, this, args)
        }
        const frame = begin()
        const { top, behavior, shape } = readArgs(args)
        const fromTop = readTop(element)
        const entry: ArrivalWrite = {
          seq: frame.seq,
          timeMs: now(),
          kind: name,
          scrollerGeneration: generation,
          fromTop,
          requestedTop: top,
          appliedTop: null,
          behavior,
          argShape: shape,
          immediateOffsetUnchanged: false,
          threw: false,
          nestedInSeq: frame.nestedInSeq,
          stack: captureStack()
        }
        try {
          const result: void = Reflect.apply(original, this, args)
          entry.appliedTop = readTop(element)
          entry.immediateOffsetUnchanged = entry.appliedTop === fromTop
          push(entry)
          return result
        } catch (error) {
          entry.threw = true
          push(entry)
          throw error
        } finally {
          depth--
        }
      }
      // Carry the original descriptor's flags instead of hardcoding them, so the wrapper is
      // indistinguishable from the native method to anything that inspects the prototype.
      Object.defineProperty(prototype, name, {
        configurable: methodDescriptor?.configurable ?? true,
        enumerable: methodDescriptor?.enumerable ?? false,
        writable: methodDescriptor?.writable ?? true,
        value: patched
      })
      restores.push(() => {
        if (methodDescriptor) {
          Object.defineProperty(prototype, name, methodDescriptor)
          return
        }
        Reflect.deleteProperty(prototype, name)
      })
    }

    const get = scrollTopDescriptor?.get
    const set = scrollTopDescriptor?.set
    if (scrollTopDescriptor && get && set) {
      Object.defineProperty(prototype, 'scrollTop', {
        configurable: true,
        enumerable: scrollTopDescriptor.enumerable,
        get,
        set(this: Element, value: number) {
          const element = asSidebar(this)
          if (!element) {
            set.call(this, value)
            return
          }
          const frame = begin()
          const fromTop = get.call(element)
          const entry: ArrivalWrite = {
            seq: frame.seq,
            timeMs: now(),
            kind: 'scrollTop=',
            scrollerGeneration: generation,
            fromTop,
            requestedTop: value,
            appliedTop: null,
            behavior: null,
            argShape: 'number',
            immediateOffsetUnchanged: false,
            threw: false,
            nestedInSeq: frame.nestedInSeq,
            stack: captureStack()
          }
          try {
            set.call(element, value)
            entry.appliedTop = get.call(element)
            entry.immediateOffsetUnchanged = entry.appliedTop === fromTop
            push(entry)
          } catch (error) {
            entry.threw = true
            push(entry)
            throw error
          } finally {
            depth--
          }
        }
      })
      restores.push(() => {
        Object.defineProperty(prototype, 'scrollTop', scrollTopDescriptor)
      })
    }

    return {
      scroller: () => {
        if (known !== null && known.isConnected) {
          return known
        }
        const live = document.querySelector<HTMLElement>(selector)
        if (!live) {
          return null
        }
        if (live !== known) {
          noteGeneration(live, 'sample')
        }
        return live
      },
      takeWriteCursor: () => {
        const sinceLastSample = totalWrites - cursorSeenWrites
        cursorSeenWrites = totalWrites
        return { sinceLastSample, lastSeq: currentOuterSeq }
      },
      noteMissingSample: () => {
        missingSamples.push({ timeMs: now(), reason: 'no-element' })
      },
      log: () => ({
        writes,
        generations,
        missingSamples,
        totalWrites,
        nestedWrites,
        recordedEntries: writes.length,
        truncatedEntries,
        immediateOffsetUnchangedWrites,
        threwWrites,
        byKind,
        smoothWrites,
        generationCount: generation
      }),
      stop: () => {
        for (const restore of restores.reverse()) {
          restore()
        }
        restores.length = 0
      }
    }
  }

  window.__arrivalRecorder = { create }
}
