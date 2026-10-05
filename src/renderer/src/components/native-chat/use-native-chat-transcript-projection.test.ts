// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatAsyncQuestionsView } from '../../../../shared/native-chat-async-questions'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { useNativeChatTranscriptProjection } from './use-native-chat-transcript-projection'

afterEach(cleanup)

const messages: NativeChatMessage[] = [
  {
    id: 'a1',
    role: 'assistant',
    blocks: [
      { type: 'text', text: 'Which name?' },
      {
        type: 'tool-call',
        name: 'request_user_input_async',
        input: '{"questions":[{"title":"Which name?","options":["core","base"]}]}',
        callId: 'call-1'
      }
    ],
    timestamp: 1,
    source: 'transcript'
  }
]

const session = (asyncQuestions?: NativeChatAsyncQuestionsView): NativeChatLiveSession => ({
  messages,
  status: 'ready',
  sessionId: 'session-1',
  agent: 'codex',
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: vi.fn(),
  readPhase: 'ready',
  ...(asyncQuestions ? { asyncQuestions } : {})
})

it('folds an async question call away only while the session card shows its questions', () => {
  const hook = renderHook(
    ({ live }: { live: NativeChatLiveSession }) =>
      useNativeChatTranscriptProjection(live, undefined, undefined),
    {
      initialProps: {
        live: session({
          state: 'ready',
          questions: [{ key: '["request_user_input_async","call-1",0]', index: 0, title: 'Q' }]
        })
      }
    }
  )
  expect(JSON.stringify(hook.result.current.messages)).not.toContain('request_user_input_async')
  // An older host publishes no set: the row and its options stay, as before.
  hook.rerender({ live: session() })
  expect(JSON.stringify(hook.result.current.messages)).toContain('base')
})
