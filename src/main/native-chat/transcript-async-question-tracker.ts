// Per-subscription host derivation of pending Codex async questions for one watched
// rollout. Reconstruction runs backward from the snapshot's consumed-byte boundary;
// lines appended past that boundary meanwhile are buffered and folded after it, in
// file order, so a live subscriber and a fresh one derive the same set from the same
// file. Until reconstruction finishes the published state is `pending`, never partial.
// The fold lives only in memory and is rebuilt from the file on subscribe and replace.

import {
  createNativeChatAsyncQuestionFoldState,
  foldNativeChatAsyncQuestionFact,
  nativeChatAsyncQuestionsFieldsEqual,
  nativeChatAsyncQuestionsFromFold,
  publishNativeChatAsyncQuestions,
  type NativeChatAsyncQuestionFact,
  type NativeChatAsyncQuestionFoldState,
  type NativeChatAsyncQuestionsField
} from '../../shared/native-chat-async-questions'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import {
  codexOversizedRolloutRecordFacts,
  codexRolloutAsyncQuestionFacts
} from './codex-rollout-async-question-facts'
import type { OversizedTranscriptRecordObserver } from './transcript-incremental-reader'
import type { SubscribeNativeChatTranscriptArgs } from './transcript-watch-contract'
import type { NativeChatLineDecoder } from './transcript-tail-reader'
import { scanCodexAsyncQuestionFactsBefore } from './transcript-async-question-boundary-scan'

export type TranscriptAsyncQuestionTracker = {
  /** Reconstruct the set before `endOffset`; lines observed afterwards start at it. */
  begin: (endOffset: number) => void
  /** Restart as a forward read from the start of the file (complete by construction). */
  beginFromStart: () => void
  /** Feed one line read at or past the boundary, in file order. */
  observeLine: (line: string, recordId: string) => void
  /** Feed the head of a line too large to read, in file order. */
  observeOversizedRecord: OversizedTranscriptRecordObserver
  /** The field to publish now. */
  field: () => NativeChatAsyncQuestionsField
  /** The field if it changed since the last call to this or `markPublished`, else undefined. */
  takeChanged: () => NativeChatAsyncQuestionsField | undefined
  markPublished: (field: NativeChatAsyncQuestionsField) => void
  /** Retry a reconstruction a failed read left unfinished. */
  retryIfFailed: () => void
  dispose: () => void
}

const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000

export function createTranscriptAsyncQuestionTracker(args: {
  filePath: string
  /** Called when a reconstruction finishes outside a drain. */
  onSettled: () => void
  scan?: typeof scanCodexAsyncQuestionFactsBefore
}): TranscriptAsyncQuestionTracker {
  const scan = args.scan ?? scanCodexAsyncQuestionFactsBefore
  let fold: NativeChatAsyncQuestionFoldState = createNativeChatAsyncQuestionFoldState()
  let reconstructing = false
  let buffered: NativeChatAsyncQuestionFact[] = []
  let generation = 0
  let failedBoundary: number | null = null
  let disposed = false
  let controller = new AbortController()
  let published: NativeChatAsyncQuestionsField | undefined
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let consecutiveFailures = 0

  function clearRetryTimer(): void {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function currentField(): NativeChatAsyncQuestionsField {
    return reconstructing
      ? { state: 'pending' }
      : publishNativeChatAsyncQuestions(nativeChatAsyncQuestionsFromFold(fold))
  }

  function reset(): void {
    clearRetryTimer()
    generation += 1
    controller.abort()
    controller = new AbortController()
    fold = createNativeChatAsyncQuestionFoldState()
    buffered = []
    failedBoundary = null
  }

  function begin(endOffset: number): void {
    reset()
    reconstructing = true
    const runGeneration = generation
    const { signal } = controller
    void scan(args.filePath, endOffset, signal).then(
      (facts) => {
        if (disposed || runGeneration !== generation) {
          return
        }
        for (const fact of [...facts, ...buffered]) {
          foldNativeChatAsyncQuestionFact(fold, fact)
        }
        buffered = []
        reconstructing = false
        consecutiveFailures = 0
        args.onSettled()
      },
      (error: unknown) => {
        if (disposed || runGeneration !== generation) {
          return
        }
        // Stay pending (never partial). A drain retries at once; an idle file has no drain,
        // so a backed-off retry of its own runs until success, a reset, or unsubscribe.
        failedBoundary = endOffset
        consecutiveFailures += 1
        console.warn('[native-chat] async-question reconstruction failed; retrying', error)
        retryTimer = setTimeout(
          retryIfFailed,
          Math.min(RETRY_BASE_MS * 2 ** (consecutiveFailures - 1), RETRY_MAX_MS)
        )
      }
    )
  }

  function retryIfFailed(): void {
    if (failedBoundary === null || disposed) {
      return
    }
    // Lines buffered past the boundary still apply after the retried scan.
    const pending = buffered
    begin(failedBoundary)
    buffered = pending
  }

  function observe(facts: readonly NativeChatAsyncQuestionFact[]): void {
    for (const fact of facts) {
      if (reconstructing) {
        buffered.push(fact)
      } else {
        foldNativeChatAsyncQuestionFact(fold, fact)
      }
    }
  }

  return {
    begin,
    beginFromStart: () => {
      reset()
      reconstructing = false
    },
    observeLine: (line, recordId) => observe(codexRolloutAsyncQuestionFacts(line, recordId)),
    observeOversizedRecord: (head) =>
      observe(codexOversizedRolloutRecordFacts(head.toString('utf8'))),
    field: currentField,
    takeChanged: () => {
      const next = currentField()
      if (nativeChatAsyncQuestionsFieldsEqual(next, published)) {
        return undefined
      }
      published = next
      return next
    },
    markPublished: (field) => {
      published = field
    },
    retryIfFailed,
    dispose: () => {
      disposed = true
      clearRetryTimer()
      controller.abort()
    }
  }
}

export type WatchedTranscriptAsyncQuestions = Pick<
  TranscriptAsyncQuestionTracker,
  'begin' | 'beginFromStart' | 'retryIfFailed' | 'takeChanged' | 'dispose'
> & {
  /** Decoder for reads past the boundary: feeds each line to the fold, then decodes it. */
  readDecode: NativeChatLineDecoder
  observeOversizedRecord: OversizedTranscriptRecordObserver
  /** The field a snapshot or replacement carries, recorded as published. */
  snapshotField: () => NativeChatAsyncQuestionsField
}

/** The watcher's async-question wiring; null (no field, no cost) for non-Codex agents. */
export function createWatchedTranscriptAsyncQuestions(
  args: Pick<SubscribeNativeChatTranscriptArgs, 'agent' | 'onAppend'>,
  filePath: string,
  decode: NativeChatLineDecoder,
  canPublish: () => boolean
): WatchedTranscriptAsyncQuestions | null {
  if (resolveNativeChatTranscriptAgent(args.agent) !== 'codex') {
    return null
  }
  const tracker = createTranscriptAsyncQuestionTracker({
    filePath,
    onSettled: () => {
      const changed = canPublish() ? tracker.takeChanged() : undefined
      if (changed) {
        args.onAppend([], undefined, changed)
      }
    }
  })
  return {
    begin: tracker.begin,
    beginFromStart: tracker.beginFromStart,
    retryIfFailed: tracker.retryIfFailed,
    takeChanged: tracker.takeChanged,
    dispose: tracker.dispose,
    observeOversizedRecord: tracker.observeOversizedRecord,
    readDecode: (line, fallbackId) => {
      tracker.observeLine(line, fallbackId)
      return decode(line, fallbackId)
    },
    snapshotField: () => {
      const field = tracker.field()
      tracker.markPublished(field)
      return field
    }
  }
}
