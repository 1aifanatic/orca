// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { NativeChatImageAttachmentPreview } from './NativeChatImageAttachmentPreview'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

const mocks = vi.hoisted(() => ({
  useLocalImageSrc: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/editor/useLocalImageSrc', () => ({
  useLocalImageSrc: mocks.useLocalImageSrc
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  mocks.useLocalImageSrc.mockReset()
})

function renderPreview(attachment: NativeChatComposerImageAttachment): void {
  vi.stubGlobal('IntersectionObserver', undefined)
  render(<NativeChatImageAttachmentPreview attachment={attachment} onRemove={vi.fn()} />)
}

describe('NativeChatImageAttachmentPreview', () => {
  it('shows the clipboard thumbnail and a spinner while pending', () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    renderPreview({ id: 'a1', path: '', previewUrl: 'blob:clipboard-1', pending: true })

    expect(document.querySelector('.animate-spin')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Saving pasted image…' }).getAttribute('src')).toBe(
      'blob:clipboard-1'
    )
  })

  it('renders no spinner once the attachment has settled', () => {
    mocks.useLocalImageSrc.mockReturnValue('blob:on-disk-1')
    renderPreview({ id: 'a1', path: '/tmp/example.png' })

    expect(document.querySelector('.animate-spin')).toBeFalsy()
  })

  it('does not read the on-disk file while the attachment is pending', () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    renderPreview({ id: 'a1', path: '', previewUrl: 'blob:clipboard-1', pending: true })

    expect(mocks.useLocalImageSrc).toHaveBeenCalledWith(undefined, '', undefined, undefined)
  })

  // The path names a file on the paired server; this machine's disk must never be asked for it.
  it('reads a stored chip back through the server that holds it', () => {
    mocks.useLocalImageSrc.mockReturnValue('blob:from-server')
    const path = '/srv/agent-session-attachments/s/u1/shot.png'
    renderPreview({
      id: 'a1',
      path,
      hostOwner: { environmentId: 'env-1', pairingRevision: 7, sessionId: 'session-1' }
    })

    for (const call of mocks.useLocalImageSrc.mock.calls) {
      expect(call[3]).toEqual({
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: null,
        worktreePath: null
      })
    }
    expect(mocks.useLocalImageSrc).toHaveBeenCalledWith(path, path, undefined, expect.anything())
    expect(screen.getByRole('img', { name: 'shot.png' }).getAttribute('src')).toBe(
      'blob:from-server'
    )
  })

  it('labels a dropped file while it uploads', () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    renderPreview({ id: 'a1', path: '', pending: true, pendingName: 'notes.md' })

    expect(screen.getByRole('button', { name: /^Uploading .* file\(s\) to remote…$/ })).toBeTruthy()
  })
})
