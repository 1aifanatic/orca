import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  nativeChatPendingAttachmentSnapshot,
  revealNativeChatPendingAttachment,
  subscribeToNativeChatPendingAttachments,
  takeNativeChatPendingAttachment
} from './native-chat-pending-attachment-cache'

afterEach(() => clearNativeChatPendingAttachmentsForTests())

describe('the pane pending attachment cache', () => {
  it('keeps a chip with no composer subscribed, so one a prompt unmounted can still settle', () => {
    addNativeChatPendingAttachment('pane-a', {
      id: 'a1',
      path: '',
      pending: true,
      previewUrl: 'blob:preview'
    })

    // The composer keeps its own preview; the cache never holds one.
    expect(nativeChatPendingAttachmentSnapshot('pane-a')).toEqual([
      { id: 'a1', path: '', pending: true }
    ])
    expect(takeNativeChatPendingAttachment('pane-a', 'a1')).toEqual({
      id: 'a1',
      path: '',
      pending: true
    })
    expect(nativeChatPendingAttachmentSnapshot('pane-a')).toEqual([])
  })

  it('answers undefined for a chip the user already removed, so its file never attaches', () => {
    addNativeChatPendingAttachment('pane-b', { id: 'b1', path: '', pending: true })
    takeNativeChatPendingAttachment('pane-b', 'b1')

    expect(takeNativeChatPendingAttachment('pane-b', 'b1')).toBeUndefined()
  })

  it('shows a hidden chip and tells every subscriber, with a new snapshot only on change', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToNativeChatPendingAttachments('pane-c', listener)
    addNativeChatPendingAttachment('pane-c', { id: 'c1', path: '', pending: true, hidden: true })
    const hidden = nativeChatPendingAttachmentSnapshot('pane-c')

    expect(nativeChatPendingAttachmentSnapshot('pane-c')).toBe(hidden)
    revealNativeChatPendingAttachment('pane-c', 'c1')

    expect(nativeChatPendingAttachmentSnapshot('pane-c')).toEqual([
      { id: 'c1', path: '', pending: true }
    ])
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})
