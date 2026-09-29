import { describe, expect, it } from 'vitest'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { normalizeNativeChatUserText } from '../../shared/native-chat-image-transcript-markers'
import {
  pendingSendsAsMessages,
  prunePendingSends
} from '../../renderer/src/components/native-chat/native-chat-pending'
import type { NativeChatMessage } from '../../shared/native-chat-types'

const prompt = 'Summarize the failing tests.\n\nThen propose a fix for each one.'
const wrapped = `\n\n<pasted_content id="7e64">\n${prompt}\n</pasted_content id="7e64">\n`
function decode(text: string, role = 'user', array = false) {
  return decodeClaudeTranscriptLine(
    JSON.stringify({
      type: role,
      uuid: 'user',
      message: { content: array ? [{ type: 'text', text }] : text }
    }),
    'fallback'
  )!
}
function message(id: string, role: NativeChatMessage['role'], text: string): NativeChatMessage {
  return { id, role, source: 'transcript', timestamp: null, blocks: [{ type: 'text', text }] }
}

describe('Claude whole-block paste envelope', () => {
  it.each([false, true])('decodes host user content (array=%s)', (array) => {
    expect(decode(wrapped, 'user', array).blocks).toEqual([{ type: 'text', text: prompt }])
  })
  it('accepts CRLF and a wrapper without ids', () => {
    expect(decode(`<pasted_content>\r\n${prompt}\r\n</pasted_content>`).blocks).toEqual([
      { type: 'text', text: prompt }
    ])
  })
  it.each([
    `Explain this:\n${wrapped}`,
    wrapped.replace('id="7e64">\n', 'id="other">\n'),
    wrapped.replace('</pasted_content id="7e64">', '</pasted_content>'),
    wrapped.replace('<pasted_content id="7e64">', '<pasted_content>'),
    `${wrapped}\n${wrapped}`
  ])('preserves prose and nonmatching envelopes', (text) => {
    expect(decode(text).blocks).toEqual([{ type: 'text', text }])
  })
  it('leaves assistant text untouched', () => {
    expect(decode(wrapped, 'assistant').blocks).toEqual([{ type: 'text', text: wrapped }])
  })
  it.each(['new host', 'old host'])('retires desktop echoes with %s rows', (host) => {
    const history = [
      message('boundary', 'assistant', 'earlier'),
      host === 'new host' ? decode(wrapped) : message('user', 'user', wrapped),
      message('reply', 'assistant', 'answer')
    ]
    const pending = [{ id: 'p1', text: prompt, sentAt: 999_000, afterMessageId: 'boundary' }]
    expect(pendingSendsAsMessages(pending, history)).toEqual([])
    expect(prunePendingSends(pending, history)).toEqual([])
    expect(
      prunePendingSends([...pending, { ...pending[0]!, id: 'p2', matchingOccurrence: 2 }], history)
    ).toHaveLength(1)
  })
  it('handles a large prompt in linear passes', () => {
    const text = 'line\n'.repeat(50_000)
    expect(
      normalizeNativeChatUserText(`<pasted_content id="a">\n${text}\n</pasted_content id="a">`)
    ).toBe(text.trim().replace(/\s+/g, ' '))
  })
})
