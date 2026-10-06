import { describe, expect, it } from 'vitest'
import { OpenCodeTimelineTranslator } from './timeline-translator'
import { MAX_REQUESTS, MAX_SESSIONS, MAX_TEXT } from './timeline-shapes'

describe('OpenCode timeline isolation', () => {
  it.each([1, 2] as const)(
    'keeps a child usage report out of root context for major %s',
    (major) => {
      const translator = new OpenCodeTimelineTranslator({ sessionId: 'root', major })
      translator.registerSession({ id: 'child', parentID: 'root' })
      const event =
        major === 1
          ? {
              type: 'message.part.updated',
              data: {
                part: {
                  sessionID: 'child',
                  id: 'step',
                  type: 'step-finish',
                  tokens: { input: 321, output: 4 }
                }
              }
            }
          : {
              type: 'session.step.ended',
              data: {
                sessionID: 'child',
                assistantMessageID: 'step',
                tokens: { input: 321, output: 4 }
              }
            }
      expect(translator.translate(event).events).toEqual([])
    }
  )

  it('refuses excess owned requests rather than dropping an approval and hanging its turn', () => {
    const translator = new OpenCodeTimelineTranslator({ sessionId: 'root', major: 1 })
    for (let index = 0; index < MAX_REQUESTS; index += 1) {
      translator.translate({
        type: 'permission.asked',
        data: { sessionID: 'root', id: `ask-${index}`, permission: 'bash', patterns: ['echo ok'] }
      })
    }
    expect(() =>
      translator.translate({
        type: 'permission.asked',
        data: { sessionID: 'root', id: 'overflow', permission: 'bash' }
      })
    ).toThrow('request limit')
    expect(translator.pending.size).toBe(MAX_REQUESTS)
  })

  it('bounds owned children and text snapshots', () => {
    const translator = new OpenCodeTimelineTranslator({ sessionId: 'root', major: 1 })
    for (let index = 1; index < MAX_SESSIONS; index += 1) {
      translator.registerSession({ id: `child-${index}`, parentID: 'root' })
    }
    expect(() => translator.registerSession({ id: 'overflow', parentID: 'root' })).toThrow(
      'child session limit'
    )
    translator.textSnapshot('text', 'assistant', 'x'.repeat(MAX_TEXT + 1), false, 'root')
    expect(translator.texts.get('text')?.text.length).toBe(MAX_TEXT)
  })

  it('rejects oversized nested message identities before retaining them', () => {
    const translator = new OpenCodeTimelineTranslator({ sessionId: 'root', major: 1 })
    expect(() =>
      translator.translate({
        type: 'message.updated',
        data: { info: { sessionID: 'root', id: 'x'.repeat(4096), role: 'assistant' } }
      })
    ).toThrow('identity exceeds')
    expect(translator.messageRole.size).toBe(0)
    expect(() =>
      translator.translate({
        type: 'message.part.updated',
        data: {
          part: {
            sessionID: 'root',
            id: 'text',
            messageID: 'x'.repeat(4096),
            type: 'text',
            text: 'ok'
          }
        }
      })
    ).toThrow('reference exceeds')
    expect(translator.textMessage.size).toBe(0)
  })
})
