import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createDomTextSearchHighlights,
  findDomTextSearchRanges,
  type DomTextSearchInstance,
  type DomTextSearchScope
} from '@/lib/dom-text-search-highlights'

// Must match the ::highlight() selectors in native-chat-find.css.
const chatFindHighlights = createDomTextSearchHighlights({
  match: 'native-chat-find-match',
  active: 'native-chat-find-active-match'
})

const TRANSCRIPT_COLUMN_SELECTOR = '[data-native-chat-transcript-column]'
const TRANSCRIPT_SCROLL_SELECTOR = '[data-native-chat-scroll]'

/** Only what the reader can see: no screen-reader labels, no hidden or faded-out controls. */
function visibleTextScope(): DomTextSearchScope {
  const rejected = new Map<HTMLElement, boolean>()
  return {
    rejectElement: (element) => {
      let reject = rejected.get(element)
      if (reject === undefined) {
        reject =
          element.closest('.sr-only, [hidden]') !== null ||
          (typeof element.checkVisibility === 'function' &&
            !element.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
        rejected.set(element, reject)
      }
      return reject
    },
    // Highlighted code splits a line into token spans; match across them.
    joinedTextSelector: 'code'
  }
}

type MatchAnchor = { node: Node; offset: number }

function anchorOf(range: Range | undefined): MatchAnchor | null {
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

/** After the transcript changed, the same match if it survived, else the next one after it. */
function stableMatchIndex(
  matches: readonly Range[],
  anchor: MatchAnchor | null,
  previousIndex: number
): number {
  if (matches.length === 0) {
    return -1
  }
  if (!anchor || !anchor.node.isConnected) {
    return Math.min(Math.max(previousIndex, 0), matches.length - 1)
  }
  const exact = matches.findIndex(
    (match) => match.startContainer === anchor.node && match.startOffset === anchor.offset
  )
  if (exact !== -1) {
    return exact
  }
  const point = document.createRange()
  point.setStart(anchor.node, Math.min(anchor.offset, anchor.node.textContent?.length ?? 0))
  const after = matches.findIndex(
    (match) => match.compareBoundaryPoints(Range.START_TO_START, point) >= 0
  )
  return after === -1 ? matches.length - 1 : after
}

/** For a new query: the first match not above what the reader is looking at. */
function firstMatchInView(matches: readonly Range[], scroller: Element | null): number {
  if (matches.length === 0) {
    return -1
  }
  const viewTop = scroller?.getBoundingClientRect().top ?? Number.NEGATIVE_INFINITY
  const index = matches.findIndex((match) => match.getBoundingClientRect().bottom >= viewTop)
  return index === -1 ? matches.length - 1 : index
}

export type NativeChatFindMatches = {
  matchCount: number
  /** -1 when there is no match. */
  activeIndex: number
  step: (direction: 1 | -1) => void
}

/** Searches the chat transcript's DOM and keeps the matches current while it streams and scrolls. */
export function useNativeChatFindMatches({
  rootRef,
  query,
  isVisible,
  revealMatch
}: {
  rootRef: React.RefObject<HTMLDivElement | null>
  query: string
  isVisible: boolean
  revealMatch: (match: Range) => void
}): NativeChatFindMatches {
  const [instance] = useState<DomTextSearchInstance>(() => ({}))
  const [matchCount, setMatchCount] = useState(0)
  const [activeIndex, setActiveIndex] = useState(-1)
  const matchesRef = useRef<readonly Range[]>([])
  const activeIndexRef = useRef(-1)
  const anchorRef = useRef<MatchAnchor | null>(null)
  const searchedQueryRef = useRef<string | null>(null)

  const activate = useCallback(
    (matches: readonly Range[], index: number) => {
      activeIndexRef.current = index
      anchorRef.current = anchorOf(matches[index])
      chatFindHighlights.setActive(instance, matches[index])
      setActiveIndex(index)
    },
    [instance]
  )

  const search = useCallback(() => {
    const root = rootRef.current
    const column = root?.querySelector<HTMLElement>(TRANSCRIPT_COLUMN_SELECTOR)
    const matches = column ? findDomTextSearchRanges(column, query, visibleTextScope()) : []
    const newQuery = searchedQueryRef.current !== query
    searchedQueryRef.current = query
    matchesRef.current = matches
    chatFindHighlights.setMatches(instance, matches)
    setMatchCount(matches.length)
    if (newQuery) {
      const index = firstMatchInView(
        matches,
        root?.querySelector(TRANSCRIPT_SCROLL_SELECTOR) ?? null
      )
      activate(matches, index)
      if (index >= 0) {
        revealMatch(matches[index])
      }
      return
    }
    activate(matches, stableMatchIndex(matches, anchorRef.current, activeIndexRef.current))
  }, [activate, instance, query, revealMatch, rootRef])

  useEffect(() => {
    const root = rootRef.current
    if (!isVisible || !root) {
      return
    }
    search()
    if (!query || typeof MutationObserver === 'undefined') {
      return
    }
    let frame: number | null = null
    let column = root.querySelector(TRANSCRIPT_COLUMN_SELECTOR)
    // Streaming, rows mounting as the reader scrolls, and disclosures all land here; one search per frame.
    const observer = new MutationObserver((records) => {
      const current = root.querySelector(TRANSCRIPT_COLUMN_SELECTOR)
      const relevant =
        current !== column ||
        (current !== null && records.some((record) => current.contains(record.target)))
      column = current
      if (relevant && frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null
          search()
        })
      }
    })
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      // Disclosures; row positioning writes `style` on every scroll and is not a content change.
      attributeFilter: ['hidden', 'open', 'data-state']
    })
    return () => {
      observer.disconnect()
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [isVisible, query, rootRef, search])

  useEffect(() => () => chatFindHighlights.clear(instance), [instance])

  const step = useCallback(
    (direction: 1 | -1) => {
      const matches = matchesRef.current
      if (matches.length === 0) {
        return
      }
      const current = activeIndexRef.current
      const index =
        current < 0
          ? direction > 0
            ? 0
            : matches.length - 1
          : (current + direction + matches.length) % matches.length
      activate(matches, index)
      revealMatch(matches[index])
    },
    [activate, revealMatch]
  )

  return { matchCount, activeIndex, step }
}
