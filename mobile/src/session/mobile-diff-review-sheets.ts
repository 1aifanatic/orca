import { useEffect, useMemo, useReducer, useRef } from 'react'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import type { ComposerState, SendSheetState } from './mobile-diff-review-screen-model'

// iOS cannot present a native Modal while another is still presented (even mid-close), so the
// review screen's sheets live in one state that mounts at most one of them at a time.

export type ReviewSheet =
  | { kind: 'actions' }
  | { kind: 'send'; load: SendSheetState }
  | { kind: 'discard'; target: MobileDiffReviewQueueItem }
  | { kind: 'composer'; composer: ComposerState }
  | { kind: 'completion' }

export type ReviewSheetKind = ReviewSheet['kind']

export type ReviewSheetsState = {
  /** The one mounted sheet; kept while it animates closed so its content does not blank. */
  current: ReviewSheet | null
  /** Whether `current` is shown; false while it is closing. */
  open: boolean
  /** Shown once `current` has finished closing; the latest request wins. */
  next: ReviewSheet | null
}

export type ReviewSheetsAction =
  | { type: 'open'; sheet: ReviewSheet }
  | { type: 'openWhenIdle'; sheet: ReviewSheet }
  | { type: 'close'; kind: ReviewSheetKind }
  | { type: 'closed'; kind: ReviewSheetKind }
  | { type: 'updateSend'; load: SendSheetState }

export const NO_REVIEW_SHEETS: ReviewSheetsState = { current: null, open: false, next: null }

export function reduceReviewSheets(
  state: ReviewSheetsState,
  action: ReviewSheetsAction
): ReviewSheetsState {
  switch (action.type) {
    case 'open':
      if (!state.current || state.current.kind === action.sheet.kind) {
        return { current: action.sheet, open: true, next: null }
      }
      return { ...state, open: false, next: action.sheet }
    case 'openWhenIdle':
      // Why: a background opener waits for the user's sheet and never displaces what they asked for,
      // including one queued behind a closing sheet of the opener's own kind.
      if (state.next && state.next.kind !== action.sheet.kind) {
        return state
      }
      if (!state.current || state.current.kind === action.sheet.kind) {
        return { current: action.sheet, open: true, next: null }
      }
      return { ...state, next: action.sheet }
    case 'close':
      if (state.current?.kind === action.kind && state.open) {
        return { ...state, open: false }
      }
      if (state.next?.kind === action.kind) {
        return { ...state, next: null }
      }
      return state
    case 'closed':
      if (state.current?.kind !== action.kind || state.open) {
        return state
      }
      return { current: state.next, open: state.next !== null, next: null }
    case 'updateSend':
      if (state.current?.kind === 'send' && state.open) {
        return { ...state, current: { kind: 'send', load: action.load } }
      }
      if (state.next?.kind === 'send') {
        return { ...state, next: { kind: 'send', load: action.load } }
      }
      // Why: a list that resolves after Send Notes was dismissed must not bring it back.
      return state
  }
}

/** The kind of the sheet on screen, or null while none is shown (including mid-close). */
export function shownReviewSheet(state: ReviewSheetsState): ReviewSheetKind | null {
  return state.open && state.current ? state.current.kind : null
}

export function reviewSendSheet(state: ReviewSheetsState): SendSheetState | null {
  return state.current?.kind === 'send' ? state.current.load : null
}

export function reviewComposer(state: ReviewSheetsState): ComposerState | null {
  return state.current?.kind === 'composer' ? state.current.composer : null
}

export function reviewDiscardTarget(state: ReviewSheetsState): MobileDiffReviewQueueItem | null {
  return state.current?.kind === 'discard' ? state.current.target : null
}

/** The only ways callers change the review screen's sheets. */
export function reviewSheetIntents(dispatch: (action: ReviewSheetsAction) => void) {
  return {
    openSheet: (sheet: ReviewSheet) => dispatch({ type: 'open', sheet }),
    /** For async openers: waits for the user's sheet to close instead of closing it. */
    openSheetWhenIdle: (sheet: ReviewSheet) => dispatch({ type: 'openWhenIdle', sheet }),
    closeSheet: (kind: ReviewSheetKind) => dispatch({ type: 'close', kind }),
    /** From that sheet's drawer once it has fully unmounted. */
    sheetClosed: (kind: ReviewSheetKind) => dispatch({ type: 'closed', kind }),
    updateSendSheet: (load: SendSheetState) => dispatch({ type: 'updateSend', load })
  }
}

export type ReviewSheetIntents = ReturnType<typeof reviewSheetIntents>

/** Review sheets; each drawer must render `visible` from `shownReviewSheet` in the same commit. */
export function useReviewSheets() {
  const [sheets, dispatch] = useReducer(reduceReviewSheets, NO_REVIEW_SHEETS)
  // The sheet whose drawer is mounted: shown in a commit and not yet reported closed.
  const mountedKindRef = useRef<ReviewSheetKind | null>(null)
  const intents = useMemo(() => {
    const base = reviewSheetIntents(dispatch)
    return {
      ...base,
      sheetClosed: (kind: ReviewSheetKind) => {
        if (mountedKindRef.current === kind) {
          mountedKindRef.current = null
        }
        base.sheetClosed(kind)
      }
    }
  }, [])
  const shown = shownReviewSheet(sheets)
  const closing = !sheets.open && sheets.current ? sheets.current.kind : null
  useEffect(() => {
    if (shown) {
      mountedKindRef.current = shown
      return
    }
    // Why: a sheet closed or displaced before any commit showed it never mounted a drawer, so
    // no onAfterClose will come; waiting for one would hold every later sheet behind it.
    if (closing && mountedKindRef.current !== closing) {
      dispatch({ type: 'closed', kind: closing })
    }
  }, [shown, closing])
  return { sheets, intents }
}
