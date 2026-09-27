import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('./editor-file-save-attempt', () => ({ attemptEditorFileSave: vi.fn() }))

import { MissingEditorFileBanner } from './MissingEditorFileBanner'

const file = {
  id: 'file-1',
  filePath: '/repo/file.ts',
  relativePath: 'file.ts',
  worktreeId: 'wt-1',
  language: 'typescript',
  isDirty: true,
  externalMutation: 'deleted',
  mode: 'edit'
} satisfies OpenFile

describe('MissingEditorFileBanner', () => {
  it('explains that edits are preserved and offers an explicit restore action', () => {
    const html = renderToStaticMarkup(<MissingEditorFileBanner file={file} />)

    expect(html).toContain('role="alert"')
    expect(html).toContain('will not be saved automatically')
    expect(html).toContain('Restore File')
  })
})
