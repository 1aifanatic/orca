// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { NativeChatImageAttachmentPreview } from './NativeChatImageAttachmentPreview'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

const mocks = vi.hoisted(() => ({
  useLocalImageSrc: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name]))
}))

vi.mock('@/components/editor/useLocalImageSrc', () => ({
  useLocalImageSrc: mocks.useLocalImageSrc
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  mocks.useLocalImageSrc.mockReset()
})

function renderPreview(
  attachment: NativeChatComposerImageAttachment,
  hostEnvironmentId?: string
): void {
  vi.stubGlobal('IntersectionObserver', undefined)
  render(
    <NativeChatImageAttachmentPreview
      attachment={attachment}
      hostEnvironmentId={hostEnvironmentId}
      onRemove={vi.fn()}
    />
  )
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
    const path = '/srv/agent-session-attachments/u1/shot.png'
    renderPreview({ id: 'a1', path }, 'env-1')

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

  it('keeps any other path on the chat\'s usual read route', () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    renderPreview({ id: 'a1', path: '/repo/docs/shot.png' }, 'env-1')

    expect(mocks.useLocalImageSrc).toHaveBeenCalledWith(
      '/repo/docs/shot.png',
      '/repo/docs/shot.png',
      undefined,
      undefined
    )
  })

  it('shows a dropped file by name and kind while it uploads', () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    renderPreview({ id: 'a1', path: '', pending: true, pendingName: 'report.pdf' })

    expect(screen.getByRole('button', { name: 'Uploading report.pdf…' })).toBeTruthy()
    expect(screen.getByText('report.pdf')).toBeTruthy()
    expect(document.querySelector('.lucide-file-text')).toBeTruthy()
    expect(document.querySelector('.lucide-image')).toBeFalsy()
  })

  it('shows a dropped image as an image while it uploads', () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    renderPreview({ id: 'a1', path: '', pending: true, pendingName: 'shot.png' })

    expect(screen.getByText('shot.png')).toBeTruthy()
    expect(document.querySelector('.lucide-image')).toBeTruthy()
  })
})
