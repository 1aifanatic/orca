import { describe, expect, it } from 'vitest'
import { nativeChatComposerPrimaryAction } from './native-chat-composer-primary-action'

describe('the composer primary action', () => {
  it.each([
    { isWorking: false, composerEmpty: true, queue: 'held', action: 'resume' },
    { isWorking: false, composerEmpty: false, queue: 'held', action: 'send' },
    // The queue is about to send a card: the Stop its turn will need, never a flash of Send.
    { isWorking: false, composerEmpty: true, queue: 'sending', action: 'stop' },
    { isWorking: false, composerEmpty: false, queue: 'sending', action: 'send' },
    { isWorking: false, composerEmpty: true, queue: null, action: 'send' },
    { isWorking: false, composerEmpty: false, queue: null, action: 'send' },
    { isWorking: true, composerEmpty: true, queue: 'held', action: 'stop' },
    { isWorking: true, composerEmpty: false, queue: null, action: 'stop' }
  ] as const)(
    'working $isWorking, empty $composerEmpty, queue $queue: $action',
    ({ action, ...input }) => {
      expect(nativeChatComposerPrimaryAction(input)).toBe(action)
    }
  )
})
