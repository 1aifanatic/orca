import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatAsyncQuestionsField } from '../../shared/native-chat-async-questions'
import type * as BoundaryScanModule from './transcript-async-question-boundary-scan'
import { subscribeNativeChatTranscript } from './transcript-watch'
import type { NativeChatTranscriptSubscription } from './transcript-watch-contract'

const scanControl = vi.hoisted(() => ({ failures: 0 }))

vi.mock('./transcript-async-question-boundary-scan', async (importOriginal) => {
  const actual = await importOriginal<typeof BoundaryScanModule>()
  return {
    ...actual,
    scanCodexAsyncQuestionFactsBefore: vi.fn(
      (...args: Parameters<typeof actual.scanCodexAsyncQuestionFactsBefore>) => {
        if (scanControl.failures > 0) {
          scanControl.failures -= 1
          return Promise.reject(new Error('gated read timed out'))
        }
        return actual.scanCodexAsyncQuestionFactsBefore(...args)
      }
    )
  }
})

let root: string | null = null
let subscription: NativeChatTranscriptSubscription | null = null

afterEach(async () => {
  subscription?.unsubscribe()
  subscription = null
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

const line = (record: unknown): string => `${JSON.stringify(record)}\n`

describe('a failed async-question reconstruction', () => {
  it('publishes absent, then recovers through the watcher reconcile with no file change', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    scanControl.failures = 1
    root = await mkdtemp(join(tmpdir(), 'orca-async-retry-'))
    const filePath = join(root, 'rollout.jsonl')
    const questions = [{ title: 'Color?' }]
    await writeFile(
      filePath,
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'go' } }) +
        line({
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'AgentMessage',
              id: 'c',
              content: [{ type: 'Text', text: 'Color?' }],
              delivery: 'async',
              questions
            }
          }
        })
    )
    const fields: NativeChatAsyncQuestionsField[] = []
    const record = (field: NativeChatAsyncQuestionsField | undefined): void => {
      if (field) {
        fields.push(field)
      }
    }
    subscription = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'session',
      filePath,
      initialLimit: 40,
      debounceMs: 5,
      reconciliationIntervalMs: 20,
      onInitialSnapshot: (_m, _h, _b, _e, _l, asyncQuestions) => record(asyncQuestions),
      onReplace: (_m, _h, _b, _l, asyncQuestions) => record(asyncQuestions),
      onAppend: (_m, _l, asyncQuestions) => record(asyncQuestions)
    })
    await vi.waitFor(() => expect(fields.at(-1)?.state).toBe('absent'))
    // The first retry waits out the backoff (1 s), then rides an idle reconcile drain.
    await vi.waitFor(() => expect(fields.at(-1)?.state).toBe('ready'), { timeout: 5_000 })
    expect(fields.map((field) => field.state)).toEqual(['pending', 'absent', 'ready'])
  })
})
