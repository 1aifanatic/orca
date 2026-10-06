import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type UIEventHandler
} from 'react'
import {
  distanceFromBottom,
  isNearBottom,
  NATIVE_CHAT_FOLLOW_REARM_PX,
  nextFollowingEnd,
  shouldShowJumpToLatest,
  type ScrollGeometry
} from './native-chat-autoscroll'
import { useNativeChatDisclosurePosition } from './use-native-chat-disclosure-position'

function geometryOf(element: HTMLElement): ScrollGeometry {
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight
  }
}

function hasMeasurableViewport(element: HTMLElement | null): element is HTMLElement {
  return element !== null && element.clientHeight > 0
}

export type NativeChatTranscriptScroll = {
  showJump: boolean
  onScroll: UIEventHandler<HTMLDivElement>
  scrollToBottom: () => void
  scrollMessageToTop: (element: HTMLElement) => void
  readerLeavesEnd: () => void
  readerActs: () => void
  holdDisclosurePosition: () => void
  captureDisclosureTarget: React.MouseEventHandler<HTMLDivElement>
  untilReaderActs: (act: () => void) => () => void
}

export function useNativeChatTranscriptScroll({
  scrollRef,
  contentRef,
  itemCount,
  isWorking,
  showsTailRow,
  isVisible,
  alignToViewportTop,
  scrollToEnd,
  restoreScrollOffset,
  consumeProgrammaticScroll,
  reconcileReaderScroll
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  contentRef: React.RefObject<HTMLDivElement | null>
  itemCount: number
  isWorking: boolean
  showsTailRow: boolean
  isVisible: boolean
  alignToViewportTop: (element: HTMLElement) => void
  scrollToEnd: () => void
  restoreScrollOffset: (offset: number) => void
  consumeProgrammaticScroll: (event: Event) => boolean
  reconcileReaderScroll: (isTakingOver: boolean) => void
}): NativeChatTranscriptScroll {
  const [showJump, setShowJump] = useState(false)
  const followingRef = useRef(true)
  const detachedScrollTopRef = useRef<number | null>(null)
  const isVisibleRef = useRef(isVisible)
  const previousIsVisibleRef = useRef(isVisible)
  const previousDistanceFromEndRef = useRef(Number.POSITIVE_INFINITY)
  const readerGenerationRef = useRef(0)
  const mountedRef = useRef(true)

  const syncScrollState = useCallback((): ScrollGeometry | null => {
    const element = scrollRef.current
    if (!isVisibleRef.current || !hasMeasurableViewport(element)) {
      return null
    }
    const geometry = geometryOf(element)
    detachedScrollTopRef.current = followingRef.current ? null : geometry.scrollTop
    setShowJump(shouldShowJumpToLatest(followingRef.current, geometry))
    return geometry
  }, [scrollRef])

  const beginDisclosure = useCallback(() => {
    readerGenerationRef.current += 1
    followingRef.current = false
    reconcileReaderScroll(true)
    syncScrollState()
  }, [reconcileReaderScroll, syncScrollState])
  const settleDisclosure = useCallback(() => {
    const element = scrollRef.current
    if (isVisibleRef.current && hasMeasurableViewport(element)) {
      followingRef.current = isNearBottom(geometryOf(element), NATIVE_CHAT_FOLLOW_REARM_PX)
      syncScrollState()
    }
  }, [scrollRef, syncScrollState])
  const disclosure = useNativeChatDisclosurePosition({
    scrollRef,
    restoreScrollOffset,
    onStart: beginDisclosure,
    onSettle: settleDisclosure
  })
  const { cancel: cancelDisclosure, holdRef, preserve: preserveDisclosure } = disclosure

  const readerActs = useCallback(() => {
    readerGenerationRef.current += 1
    if (holdRef.current) {
      settleDisclosure()
    }
    cancelDisclosure()
  }, [cancelDisclosure, holdRef, settleDisclosure])
  const readerLeavesEnd = useCallback(() => {
    readerActs()
    followingRef.current = false
    const element = scrollRef.current
    if (element) {
      previousDistanceFromEndRef.current = distanceFromBottom(geometryOf(element))
    }
    // Replace a pending virtualizer target before the browser applies the gesture.
    reconcileReaderScroll(true)
    syncScrollState()
  }, [readerActs, reconcileReaderScroll, scrollRef, syncScrollState])

  const onScroll = useCallback<UIEventHandler<HTMLDivElement>>(
    (event) => {
      const element = scrollRef.current
      if (!isVisibleRef.current || !hasMeasurableViewport(element)) {
        return
      }
      const geometry = geometryOf(element)
      const programmatic = consumeProgrammaticScroll(event.nativeEvent)
      if (!holdRef.current) {
        followingRef.current = nextFollowingEnd({
          following: followingRef.current,
          programmatic,
          geometry,
          previousDistanceFromEnd: previousDistanceFromEndRef.current
        })
        reconcileReaderScroll(false)
      }
      previousDistanceFromEndRef.current = distanceFromBottom(geometry)
      syncScrollState()
    },
    [consumeProgrammaticScroll, holdRef, reconcileReaderScroll, scrollRef, syncScrollState]
  )

  const scrollToEndWhenMeasurable = useCallback(() => {
    if (isVisibleRef.current && !holdRef.current && hasMeasurableViewport(scrollRef.current)) {
      scrollToEnd()
    }
  }, [holdRef, scrollRef, scrollToEnd])
  const scrollToBottom = useCallback(() => {
    readerGenerationRef.current += 1
    cancelDisclosure()
    followingRef.current = true
    scrollToEndWhenMeasurable()
    setShowJump(false)
  }, [cancelDisclosure, scrollToEndWhenMeasurable])
  const scrollMessageToTop = useCallback(
    (element: HTMLElement) => {
      readerActs()
      followingRef.current = false
      alignToViewportTop(element)
    },
    [alignToViewportTop, readerActs]
  )
  const untilReaderActs = useCallback((act: () => void) => {
    const generation = readerGenerationRef.current
    let consumed = false
    return () => {
      if (
        !consumed &&
        mountedRef.current &&
        isVisibleRef.current &&
        readerGenerationRef.current === generation
      ) {
        consumed = true
        act()
      }
    }
  }, [])

  useLayoutEffect(() => {
    const revealed = isVisible && !previousIsVisibleRef.current
    isVisibleRef.current = isVisible
    previousIsVisibleRef.current = isVisible
    if (!isVisible) {
      readerGenerationRef.current += 1
      cancelDisclosure()
      return
    }
    if (!followingRef.current) {
      if (revealed) {
        if (detachedScrollTopRef.current !== null) {
          restoreScrollOffset(detachedScrollTopRef.current)
        }
        settleDisclosure()
      } else {
        syncScrollState()
      }
      return
    }
    scrollToEndWhenMeasurable()
  }, [
    cancelDisclosure,
    isVisible,
    itemCount,
    isWorking,
    restoreScrollOffset,
    showsTailRow,
    scrollToEndWhenMeasurable,
    settleDisclosure,
    syncScrollState
  ])

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      readerGenerationRef.current += 1
    }
  }, [])
  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      if (!isVisibleRef.current) {
        return
      }
      if (holdRef.current) {
        preserveDisclosure()
      } else if (followingRef.current) {
        scrollToEndWhenMeasurable()
      }
      syncScrollState()
    })
    observer.observe(element)
    if (contentRef.current) {
      observer.observe(contentRef.current)
    }
    return () => observer.disconnect()
  }, [
    contentRef,
    holdRef,
    preserveDisclosure,
    scrollRef,
    scrollToEndWhenMeasurable,
    syncScrollState
  ])

  return {
    showJump,
    onScroll,
    scrollToBottom,
    scrollMessageToTop,
    readerLeavesEnd,
    readerActs,
    holdDisclosurePosition: disclosure.holdPosition,
    captureDisclosureTarget: disclosure.captureTarget,
    untilReaderActs
  }
}
