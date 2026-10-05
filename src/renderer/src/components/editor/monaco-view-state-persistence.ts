import type { MutableRefObject } from 'react'
import type { editor } from 'monaco-editor'
import { editorSelectionCache, scrollTopCache, setWithLRU } from '@/lib/scroll-cache'

type MonacoViewStateTrackingParams = {
  editorInstance: editor.IStandaloneCodeEditor
  fileIdRef: MutableRefObject<string>
  viewStateKey: string
  scrollThrottleTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  setEditorCursorLine: (fileId: string, line: number) => void
}

export function installMonacoViewStateTracking(params: MonacoViewStateTrackingParams): {
  cursorPositionSub: { dispose: () => void }
  scrollStateSub: { dispose: () => void }
} {
  const { editorInstance, fileIdRef, viewStateKey, scrollThrottleTimerRef, setEditorCursorLine } =
    params

  // Track cursor line for "copy path to line" feature
  const pos = editorInstance.getPosition()
  if (pos) {
    setEditorCursorLine(fileIdRef.current, pos.lineNumber)
  }
  const cursorPositionSub = editorInstance.onDidChangeCursorPosition((e) => {
    setEditorCursorLine(fileIdRef.current, e.position.lineNumber)
  })

  // Why: only the resting scroll position matters, so trailing-throttle writes (~150ms) instead of writing every 60fps frame.
  const scrollStateSub = editorInstance.onDidScrollChange((e) => {
    if (scrollThrottleTimerRef.current !== null) {
      clearTimeout(scrollThrottleTimerRef.current)
    }
    scrollThrottleTimerRef.current = setTimeout(() => {
      setWithLRU(scrollTopCache, viewStateKey, e.scrollTop)
      scrollThrottleTimerRef.current = null
    }, 150)
  })

  return { cursorPositionSub, scrollStateSub }
}

export function restoreMonacoViewState(
  editorInstance: Pick<
    editor.IStandaloneCodeEditor,
    'setSelections' | 'setScrollTop' | 'focus' | 'onDidDispose'
  > & {
    getLayoutInfo(): Pick<editor.EditorLayoutInfo, 'contentWidth' | 'height'>
    onDidLayoutChange(listener: () => void): { dispose(): void }
    onDidChangeModel(listener: () => void): { dispose(): void }
  },
  viewStateKey: string
): void {
  const savedSelections = editorSelectionCache.get(viewStateKey)
  const savedScrollTop = scrollTopCache.get(viewStateKey)
  if (savedScrollTop !== undefined || savedSelections) {
    let restoreFrame: number | null = null
    let active = true
    const cancelRestore = (): void => {
      if (!active) {
        return
      }
      active = false
      if (restoreFrame !== null) {
        cancelAnimationFrame(restoreFrame)
        restoreFrame = null
      }
      subscriptions.forEach((subscription) => subscription.dispose())
    }
    const restore = (): void => {
      restoreFrame = null
      if (!active) {
        return
      }
      const layout = editorInstance.getLayoutInfo()
      // Initial narrow layout wraps every character; its pixel scroll changes again on resize.
      if (layout.contentWidth <= 0 || layout.height <= 0) {
        return
      }
      cancelRestore()
      if (savedSelections) {
        editorInstance.setSelections(savedSelections)
      }
      if (savedScrollTop !== undefined) {
        editorInstance.setScrollTop(savedScrollTop)
      }
      editorInstance.focus()
    }
    const scheduleRestore = (): void => {
      if (active && restoreFrame === null) {
        restoreFrame = requestAnimationFrame(restore)
      }
    }
    const subscriptions = [
      editorInstance.onDidDispose(cancelRestore),
      editorInstance.onDidChangeModel(cancelRestore),
      editorInstance.onDidLayoutChange(scheduleRestore)
    ]
    scheduleRestore()
  } else {
    editorInstance.focus()
  }
}

// Why: takes the ref, not the instance — the caller runs this from an effect cleanup, where reading `.current` inline trips the ref-in-cleanup lint.
export function snapshotMonacoViewState(
  editorRef: MutableRefObject<editor.IStandaloneCodeEditor | null>,
  viewStateKey: string
): void {
  const ed = editorRef.current
  if (ed) {
    setWithLRU(scrollTopCache, viewStateKey, ed.getScrollTop())
    const selections = ed.getSelections()
    if (selections) {
      setWithLRU(editorSelectionCache, viewStateKey, selections)
    }
  }
}
