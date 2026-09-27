import { describe, expect, it } from 'vitest'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import type { SendSheetState } from './mobile-diff-review-screen-model'
import {
  NO_REVIEW_SHEETS,
  reduceReviewSheets,
  reviewComposer,
  reviewDiscardTarget,
  reviewSendSheet,
  shownReviewSheet,
  type ReviewSheet,
  type ReviewSheetsAction,
  type ReviewSheetsState
} from './mobile-diff-review-sheets'

const ACTIONS: ReviewSheet = { kind: 'actions' }
const COMPLETION: ReviewSheet = { kind: 'completion' }
const SEND_LOADING: ReviewSheet = { kind: 'send', load: { kind: 'loading' } }
const COMPOSER: ReviewSheet = { kind: 'composer', composer: { mode: 'create', lineNumber: 4 } }
const READY: SendSheetState = { kind: 'ready', terminals: [] }
const TARGET: MobileDiffReviewQueueItem = {
  key: 'unstaged:src/a.ts',
  scope: 'unstaged',
  area: 'unstaged',
  filePath: 'src/a.ts',
  status: 'modified',
  title: 'a.ts',
  subtitle: 'src',
  canStage: true,
  canUnstage: false,
  canDiscard: true,
  isGeneratedOrLockFile: false,
  diffIdentity: 'identity-1',
  noteCount: 0,
  unsentNoteCount: 0,
  staleNoteCount: 0,
  isReviewed: false,
  changedSinceReview: false
}

function run(...actions: ReviewSheetsAction[]): ReviewSheetsState {
  return actions.reduce(reduceReviewSheets, NO_REVIEW_SHEETS)
}

const open = (sheet: ReviewSheet): ReviewSheetsAction => ({ type: 'open', sheet })
const openWhenIdle = (sheet: ReviewSheet): ReviewSheetsAction => ({ type: 'openWhenIdle', sheet })
const close = (kind: ReviewSheet['kind']): ReviewSheetsAction => ({ type: 'close', kind })
const closed = (kind: ReviewSheet['kind']): ReviewSheetsAction => ({ type: 'closed', kind })

describe('review screen sheets', () => {
  it('opens a sheet when none is mounted', () => {
    const state = run(open(ACTIONS))
    expect(state).toEqual({ current: ACTIONS, open: true, next: null })
    expect(shownReviewSheet(state)).toBe('actions')
  })

  it('switching kinds hides the current sheet and shows the next only once it has closed', () => {
    const switching = run(open(ACTIONS), open(SEND_LOADING))
    // One sheet stays mounted (closing); the requested one is not mounted until then.
    expect(switching).toEqual({ current: ACTIONS, open: false, next: SEND_LOADING })
    expect(shownReviewSheet(switching)).toBeNull()

    const shown = reduceReviewSheets(switching, closed('actions'))
    expect(shown).toEqual({ current: SEND_LOADING, open: true, next: null })
  })

  it('keeps the closing sheet data so its content does not blank mid-close', () => {
    const closing = run(open({ kind: 'discard', target: TARGET }), close('discard'))
    expect(shownReviewSheet(closing)).toBeNull()
    expect(reviewDiscardTarget(closing)).toBe(TARGET)
    expect(reviewDiscardTarget(reduceReviewSheets(closing, closed('discard')))).toBeNull()

    const composing = run(open(COMPOSER), close('composer'))
    expect(reviewComposer(composing)).toEqual({ mode: 'create', lineNumber: 4 })
  })

  it('openWhenIdle waits for the user sheet to close and does not close it', () => {
    const waiting = run(open(ACTIONS), openWhenIdle(COMPLETION))
    expect(waiting).toEqual({ current: ACTIONS, open: true, next: COMPLETION })
    expect(shownReviewSheet(waiting)).toBe('actions')

    const closing = reduceReviewSheets(waiting, close('actions'))
    expect(shownReviewSheet(closing)).toBeNull()
    expect(shownReviewSheet(reduceReviewSheets(closing, closed('actions')))).toBe('completion')
  })

  it('openWhenIdle opens at once when nothing is mounted', () => {
    expect(run(openWhenIdle(COMPLETION))).toEqual({ current: COMPLETION, open: true, next: null })
  })

  it('openWhenIdle never displaces a sheet the user already asked for', () => {
    const state = run(open(ACTIONS), open(SEND_LOADING), openWhenIdle(COMPLETION))
    expect(state.next).toEqual(SEND_LOADING)
  })

  // Review Complete → Send Notes, then a second Mark Reviewed save lands mid-close.
  it('openWhenIdle does not reopen its own closing kind over a sheet the user asked for', () => {
    const state = run(open(COMPLETION), open(SEND_LOADING), openWhenIdle(COMPLETION))
    expect(state).toEqual({ current: COMPLETION, open: false, next: SEND_LOADING })
  })

  it('a later user request replaces a queued background sheet', () => {
    const state = run(open(ACTIONS), openWhenIdle(COMPLETION), open(SEND_LOADING))
    expect(state).toEqual({ current: ACTIONS, open: false, next: SEND_LOADING })
  })

  it('the latest request wins the queued slot', () => {
    const state = run(open(ACTIONS), open(SEND_LOADING), open(COMPOSER))
    expect(state).toEqual({ current: ACTIONS, open: false, next: COMPOSER })
    expect(reduceReviewSheets(state, closed('actions')).current).toEqual(COMPOSER)
  })

  it('updateSend after Send Notes was dismissed does not bring it back', () => {
    const dismissed = run(open(SEND_LOADING), close('send'))
    const afterList = reduceReviewSheets(dismissed, { type: 'updateSend', load: READY })
    expect(afterList).toBe(dismissed)
    expect(
      run(open(SEND_LOADING), close('send'), closed('send'), {
        type: 'updateSend',
        load: READY
      })
    ).toEqual(NO_REVIEW_SHEETS)
  })

  it('updateSend fills a shown Send Notes and a queued one', () => {
    const shown = run(open(SEND_LOADING), { type: 'updateSend', load: READY })
    expect(reviewSendSheet(shown)).toEqual(READY)

    const queued = run(open(ACTIONS), open(SEND_LOADING), { type: 'updateSend', load: READY })
    expect(queued.next).toEqual({ kind: 'send', load: READY })
    expect(shownReviewSheet(queued)).toBeNull()
  })

  it('updateSend never opens Send Notes over another sheet', () => {
    const state = run(open(ACTIONS), { type: 'updateSend', load: READY })
    expect(state).toEqual({ current: ACTIONS, open: true, next: null })
  })

  it('a stale close or closed for another kind is a no-op', () => {
    const state = run(open(ACTIONS))
    expect(reduceReviewSheets(state, close('send'))).toBe(state)
    expect(reduceReviewSheets(state, closed('send'))).toBe(state)
    // A closed for the shown sheet itself is stale too: it has not been asked to close.
    expect(reduceReviewSheets(state, closed('actions'))).toBe(state)
  })

  it('close drops a queued sheet of that kind without touching the current one', () => {
    const state = run(open(ACTIONS), openWhenIdle(COMPLETION), close('completion'))
    expect(state).toEqual({ current: ACTIONS, open: true, next: null })
  })

  it('reopening the same kind during its close re-shows it and ignores the late closed', () => {
    const reopened = run(open(ACTIONS), close('actions'), open(ACTIONS))
    expect(reopened).toEqual({ current: ACTIONS, open: true, next: null })
    expect(reduceReviewSheets(reopened, closed('actions'))).toBe(reopened)
  })

  it('reopening the closing kind cancels a queued switch', () => {
    const state = run(open(ACTIONS), open(SEND_LOADING), open(ACTIONS))
    expect(state).toEqual({ current: ACTIONS, open: true, next: null })
  })

  it('mounts at most one sheet whatever order requests arrive in', () => {
    const sheets = [ACTIONS, COMPLETION, SEND_LOADING, COMPOSER]
    const kinds = ['actions', 'completion', 'send', 'composer'] as const
    const actions: ReviewSheetsAction[] = []
    for (const sheet of sheets) {
      actions.push(open(sheet), openWhenIdle(sheet))
    }
    for (const kind of kinds) {
      actions.push(close(kind), closed(kind))
    }
    actions.push({ type: 'updateSend', load: READY })
    // Deterministic pseudo-random walk over every action.
    let seed = 7
    let state = NO_REVIEW_SHEETS
    for (let step = 0; step < 2000; step++) {
      seed = (seed * 48271) % 2147483647
      state = reduceReviewSheets(state, actions[seed % actions.length]!)
      // Shown implies mounted; `next` is never mounted, and nothing is queued behind nothing.
      if (state.open) {
        expect(state.current).not.toBeNull()
      }
      if (state.current === null) {
        expect(state.next).toBeNull()
      }
      if (state.next !== null) {
        expect(state.next.kind).not.toBe(state.current?.kind)
      }
    }
  })
})
