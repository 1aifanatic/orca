import { describe, expect, it, vi } from 'vitest'
import type { NativeChatAsyncQuestionFact } from '../../shared/native-chat-async-questions'
import { createTranscriptAsyncQuestionTracker } from './transcript-async-question-tracker'

const askLine = (callId: string, title: string): string =>
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: {
        type: 'AgentMessage',
        id: callId,
        content: [{ type: 'Text', text: title }],
        delivery: 'async',
        questions: [{ title }]
      }
    }
  })
const userLine = JSON.stringify({
  type: 'event_msg',
  payload: { type: 'user_message', message: 'x' }
})
const asked = (itemId: string, title: string): NativeChatAsyncQuestionFact => ({
  kind: 'asked',
  asker: 'root',
  itemId,
  recordId: itemId,
  questions: [{ title }]
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (e: Error) => void
} {
  let resolve: (value: T) => void = () => {}
  let reject: (e: Error) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const titles = (
  field: ReturnType<ReturnType<typeof createTranscriptAsyncQuestionTracker>['field']>
) => (field.state === 'ready' ? field.questions.map((question) => question.title) : field.state)

describe('createTranscriptAsyncQuestionTracker', () => {
  it('stays pending, buffers appends, then folds them after the reconstruction in order', async () => {
    const scan = deferred<NativeChatAsyncQuestionFact[]>()
    const onSettled = vi.fn()
    const tracker = createTranscriptAsyncQuestionTracker({
      filePath: '/f',
      onSettled,
      scan: () => scan.promise
    })
    tracker.begin(100)
    tracker.observeLine(askLine('later', 'Later?'), 'r1')
    expect(tracker.field()).toEqual({ state: 'pending' })
    scan.resolve([asked('first', 'First?')])
    await scan.promise
    await Promise.resolve()
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(titles(tracker.field())).toEqual(['First?', 'Later?'])
  })

  it('applies a user message appended during reconstruction after the reconstructed set', async () => {
    const scan = deferred<NativeChatAsyncQuestionFact[]>()
    const tracker = createTranscriptAsyncQuestionTracker({
      filePath: '/f',
      onSettled: () => {},
      scan: () => scan.promise
    })
    tracker.begin(100)
    tracker.observeLine(userLine, 'r1')
    scan.resolve([asked('first', 'First?')])
    await scan.promise
    await Promise.resolve()
    expect(titles(tracker.field())).toEqual([])
  })

  it('never publishes a partial set after a failed scan and retries from the same boundary', async () => {
    const first = deferred<NativeChatAsyncQuestionFact[]>()
    const second = deferred<NativeChatAsyncQuestionFact[]>()
    const scan = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const tracker = createTranscriptAsyncQuestionTracker({
      filePath: '/f',
      onSettled: () => {},
      scan
    })
    tracker.begin(42)
    tracker.observeLine(askLine('later', 'Later?'), 'r1')
    first.reject(new Error('shrank'))
    await first.promise.catch(() => {})
    await Promise.resolve()
    expect(tracker.field()).toEqual({ state: 'pending' })
    tracker.retryIfFailed()
    expect(scan).toHaveBeenLastCalledWith('/f', 42, expect.anything())
    second.resolve([asked('first', 'First?')])
    await second.promise
    await Promise.resolve()
    expect(titles(tracker.field())).toEqual(['First?', 'Later?'])
  })

  it('ignores a superseded reconstruction after a replace', async () => {
    const stale = deferred<NativeChatAsyncQuestionFact[]>()
    const fresh = deferred<NativeChatAsyncQuestionFact[]>()
    const scan = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    const tracker = createTranscriptAsyncQuestionTracker({
      filePath: '/f',
      onSettled: () => {},
      scan
    })
    tracker.begin(10)
    tracker.begin(20)
    stale.resolve([asked('old', 'Old?')])
    fresh.resolve([asked('new', 'New?')])
    await Promise.all([stale.promise, fresh.promise])
    await Promise.resolve()
    expect(titles(tracker.field())).toEqual(['New?'])
  })

  it('reports a change once', () => {
    const tracker = createTranscriptAsyncQuestionTracker({ filePath: '/f', onSettled: () => {} })
    tracker.beginFromStart()
    expect(tracker.takeChanged()).toEqual({ state: 'ready', questions: [] })
    expect(tracker.takeChanged()).toBeUndefined()
    tracker.observeLine(askLine('c', 'Now?'), 'r')
    expect(titles(tracker.takeChanged() ?? { state: 'pending' })).toEqual(['Now?'])
    expect(tracker.takeChanged()).toBeUndefined()
  })

  it('retries a failed reconstruction on its own while the file stays idle', async () => {
    vi.useFakeTimers()
    try {
      const scan = vi
        .fn<() => Promise<NativeChatAsyncQuestionFact[]>>()
        .mockRejectedValueOnce(new Error('busy'))
        .mockResolvedValueOnce([asked('first', 'First?')])
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const onSettled = vi.fn()
      const tracker = createTranscriptAsyncQuestionTracker({ filePath: '/f', onSettled, scan })
      tracker.begin(100)
      await vi.advanceTimersByTimeAsync(0)
      expect(tracker.field()).toEqual({ state: 'pending' })
      expect(warn).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(scan).toHaveBeenCalledTimes(2)
      expect(scan).toHaveBeenLastCalledWith('/f', 100, expect.anything())
      expect(titles(tracker.field())).toEqual(['First?'])
      expect(onSettled).toHaveBeenCalledOnce()
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops retrying after dispose', async () => {
    vi.useFakeTimers()
    try {
      const scan = vi.fn(async (): Promise<NativeChatAsyncQuestionFact[]> => {
        throw new Error('busy')
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const tracker = createTranscriptAsyncQuestionTracker({
        filePath: '/f',
        onSettled: () => {},
        scan
      })
      tracker.begin(100)
      await vi.advanceTimersByTimeAsync(0)
      tracker.dispose()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(scan).toHaveBeenCalledOnce()
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a record too large to read as a delivered user message when its head says so', () => {
    const tracker = createTranscriptAsyncQuestionTracker({
      filePath: '/f',
      onSettled: () => {},
      scan: async () => []
    })
    tracker.beginFromStart()
    tracker.observeLine(askLine('call-1', 'Color?'), 'r1')
    expect(titles(tracker.field())).toEqual(['Color?'])
    const head = '{"timestamp":"t","type":"event_msg","payload":{"type":"user_message","message":"'
    tracker.observeOversizedRecord(Buffer.from(head), 'r2')
    expect(titles(tracker.field())).toEqual([])
  })
})
