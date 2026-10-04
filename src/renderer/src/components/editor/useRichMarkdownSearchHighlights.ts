import { useEffect, useRef, type RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import { richMarkdownSearchPluginKey, type RichMarkdownSearchMatch } from './rich-markdown-search'

type SearchNavigation = {
  editor: Editor
  query: string
  matchCase: boolean
  wholeWord: boolean
  navigationRequest: number
}

export function useRichMarkdownSearchHighlights({
  activeMatchIndex,
  editor,
  matchCase,
  matches,
  navigationRequest,
  query,
  scrollContainerRef,
  wholeWord
}: {
  activeMatchIndex: number
  editor: Editor | null
  matchCase: boolean
  matches: RichMarkdownSearchMatch[]
  navigationRequest: number
  query: string
  scrollContainerRef: RefObject<HTMLDivElement | null>
  wholeWord: boolean
}): void {
  const lastNavigationRef = useRef<SearchNavigation | null>(null)

  useEffect(() => {
    if (!editor) {
      lastNavigationRef.current = null
      return
    }
    const previous = lastNavigationRef.current
    const searchChanged =
      previous?.editor !== editor ||
      previous.query !== query ||
      previous.matchCase !== matchCase ||
      previous.wholeWord !== wholeWord
    const navigationRequested = previous?.navigationRequest !== navigationRequest
    lastNavigationRef.current = { editor, query, matchCase, wholeWord, navigationRequest }

    // Refreshing matches after an edit must preserve the user's caret and viewport.
    const shouldNavigate = navigationRequested || (searchChanged && !editor.isFocused)
    const activeMatch =
      shouldNavigate && query && activeMatchIndex >= 0 ? matches[activeMatchIndex] : null
    const tr = editor.state.tr.setMeta(richMarkdownSearchPluginKey, {
      activeIndex: activeMatchIndex,
      matches,
      query
    })
    if (activeMatch) {
      tr.setSelection(TextSelection.create(tr.doc, activeMatch.from, activeMatch.to))
    }
    editor.view.dispatch(tr)

    // ProseMirror's scrollIntoView does not reliably reach the outer flex viewport.
    const container = scrollContainerRef.current
    if (activeMatch && container) {
      const coords = editor.view.coordsAtPos(activeMatch.from)
      const containerRect = container.getBoundingClientRect()
      const relativeTop = coords.top - containerRect.top
      const targetScroll = container.scrollTop + relativeTop - containerRect.height / 2
      container.scrollTo({ top: targetScroll, behavior: 'instant' })
    }
  }, [
    activeMatchIndex,
    editor,
    matchCase,
    matches,
    navigationRequest,
    query,
    scrollContainerRef,
    wholeWord
  ])
}
