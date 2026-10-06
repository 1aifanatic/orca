import { describe, expect, it } from 'vitest'
import { OpenCodeSseFrames } from './sse-frames'

describe('OpenCode server-sent event framing', () => {
  it('keeps split CRLF, multiline data, event type and the last event id', () => {
    const parser = new OpenCodeSseFrames()
    expect([...parser.push('id: 7\r')]).toEqual([])
    expect([...parser.push('\nevent: update\rdata: first\r\ndata: second\r')]).toEqual([])
    expect([...parser.push('\n\r\ndata: next\n\n')]).toEqual([
      { data: 'first\nsecond', event: 'update', id: '7' },
      { data: 'next', event: 'message', id: '7' }
    ])
  })

  it('ignores comments and unknown fields, permits empty data, and discards incomplete frames', () => {
    const parser = new OpenCodeSseFrames()
    expect([...parser.push(': heartbeat\nretry: 100\n\ndata:\n\ndata: partial')]).toEqual([
      { data: '', event: 'message', id: '' }
    ])
  })

  it('counts UTF-8 bytes and closes on oversized lines or multiline frames', () => {
    expect(() => [...new OpenCodeSseFrames(8).push('data: €')]).toThrow('line exceeds limit')
    expect(() => [...new OpenCodeSseFrames(16).push('data: abcdefgh\ndata: abcdefgh\n')]).toThrow(
      'frame exceeds limit'
    )
  })

  it('preserves many fragments and data lines while compacting retained chunks', () => {
    const parser = new OpenCodeSseFrames()
    for (let index = 0; index < 2048; index += 1) {
      expect([...parser.push('a')]).toEqual([])
    }
    expect([...parser.push('\n')]).toEqual([])
    const text = 'data: x\n'.repeat(2048)
    expect([...parser.push(`${text}\n`)][0]?.data).toBe(Array(2048).fill('x').join('\n'))
  })
})
