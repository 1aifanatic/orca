import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

type PositionHold = { element: HTMLElement | null; top: number; offset: number }

/** Preserve the clicked control through measurement, without tracking expanded rows. */
export function useNativeChatDisclosurePosition({
  scrollRef,
  restoreScrollOffset,
  onStart,
  onSettle
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  restoreScrollOffset: (offset: number) => void
  onStart: () => void
  onSettle: () => void
}) {
  const holdRef = useRef<PositionHold | null>(null)
  const targetRef = useRef<HTMLElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancel = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
    }
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current)
    }
    frameRef.current = null
    timeoutRef.current = null
    holdRef.current = null
  }, [])
  const preserve = useCallback(() => {
    const hold = holdRef.current
    const scroller = scrollRef.current
    if (!hold || !scroller || scroller.clientHeight <= 0) {
      return
    }
    const rect = scroller.getBoundingClientRect()
    const zoom =
      scroller.offsetHeight > 0 && rect.height > 0 ? rect.height / scroller.offsetHeight : 1
    const drift = hold.element?.isConnected
      ? (hold.element.getBoundingClientRect().top - hold.top) / zoom
      : hold.offset - scroller.scrollTop
    if (Math.abs(drift) >= 0.5) {
      restoreScrollOffset(scroller.scrollTop + drift)
    }
    hold.offset = scroller.scrollTop
  }, [restoreScrollOffset, scrollRef])
  const settle = useCallback(() => {
    preserve()
    cancel()
    onSettle()
  }, [cancel, onSettle, preserve])
  const captureTarget = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const element =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('button, [role="button"], summary')
        : null
    targetRef.current = element
    queueMicrotask(() => {
      if (targetRef.current === element) {
        targetRef.current = null
      }
    })
  }, [])
  const holdPosition = useCallback(() => {
    cancel()
    const scroller = scrollRef.current
    if (!scroller || scroller.clientHeight <= 0) {
      return
    }
    onStart()
    const element = targetRef.current
    holdRef.current = {
      element: element && scroller.contains(element) ? element : null,
      top: element?.getBoundingClientRect().top ?? 0,
      offset: scroller.scrollTop
    }
    // Two layout frames cover the commit and virtualizer measurement; hidden renderers have a deadline.
    frameRef.current = requestAnimationFrame(() => {
      preserve()
      frameRef.current = requestAnimationFrame(settle)
    })
    timeoutRef.current = setTimeout(settle, 250)
  }, [cancel, onStart, preserve, scrollRef, settle])
  useLayoutEffect(preserve)
  useEffect(() => cancel, [cancel])
  return { holdRef, holdPosition, captureTarget, preserve, cancel }
}
