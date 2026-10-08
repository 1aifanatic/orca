import { describe, expect, it } from 'vitest'
import { nativeChatFindScrollDelta } from './native-chat-reader-scroll-input'

describe('nativeChatFindScrollDelta', () => {
  const view = { top: 100, bottom: 600 }

  it('leaves a match the reader can already see where it is', () => {
    expect(nativeChatFindScrollDelta({ top: 300, bottom: 320 }, view)).toBeNull()
  })

  it('centres a match above, below, or under the find bar', () => {
    // Visible band is 148..600, centred at 374.
    expect(nativeChatFindScrollDelta({ top: -500, bottom: -480 }, view)).toBe(-864)
    expect(nativeChatFindScrollDelta({ top: 900, bottom: 920 }, view)).toBe(536)
    expect(nativeChatFindScrollDelta({ top: 110, bottom: 130 }, view)).toBe(-254)
  })
})
