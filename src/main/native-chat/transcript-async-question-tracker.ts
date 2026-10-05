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
import { codexRolloutAsyncQuestionFacts } from './codex-rollout-async-question-facts'
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
  /** The field to publish now. */
  field: () => NativeChatAsyncQuestionsField
  /** The field if it changed since the last call to this or `markPublished`, else undefined. */
  takeChanged: () => NativeChatAsyncQuestionsField | undefined
  markPublished: (field: NativeChatAsyncQuestionsField) => void
  /** Retry a reconstruction a failed read left unfinished. */
  retryIfFailed: () => void
  dispose: () => void
}

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

  function currentField(): NativeChatAsyncQuestionsField {
    return reconstructing
      ? { state: 'pending' }
      : publishNativeChatAsyncQuestions(nativeChatAsyncQuestionsFromFold(fold))
  }

  function reset(): void {
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
        args.onSettled()
      },
      () => {
        if (!disposed && runGeneration === generation) {
          // Stay pending (never partial); the next drain retries from the same boundary.
          failedBoundary = endOffset
        }
      }
    )
  }

  return {
    begin,
    beginFromStart: () => {
      reset()
      reconstructing = false
    },
    observeLine: (line, recordId) => {
      for (const fact of codexRolloutAsyncQuestionFacts(line, recordId)) {
        if (reconstructing) {
          buffered.push(fact)
        } else {
          foldNativeChatAsyncQuestionFact(fold, fact)
        }
      }
    },
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
    retryIfFailed: () => {
      if (failedBoundary === null || disposed) {
        return
      }
      // Lines buffered past the boundary still apply after the retried scan.
      const pending = buffered
      begin(failedBoundary)
      buffered = pending
    },
    dispose: () => {
      disposed = true
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
