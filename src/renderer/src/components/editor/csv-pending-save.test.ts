import { afterEach, expect, it, vi } from 'vitest'
import { createEditorSaveQueue } from './editor-save-queue'
import { registerPendingEditorFlush } from './editor-pending-flush'
import {
  createEditorStore,
  stubEditorWindowWithDisk
} from './editor-autosave-controller-test-fixture'

afterEach(() => vi.unstubAllGlobals())

function setup() {
  const disk = stubEditorWindowWithDisk()
  const store = createEditorStore()
  store.getState().openFile({
    filePath: '/repo/data.csv',
    relativePath: 'data.csv',
    worktreeId: 'wt-1',
    mode: 'edit',
    language: 'plaintext'
  })
  const file = store.getState().openFiles[0]!
  store.getState().setEditorDraft(file.id, 'header\nprevious')
  store.getState().markFileDirty(file.id, true)
  const queue = createEditorSaveQueue(store)
  return { disk, store, file, queue }
}

it('autosave flushes a pending cell and reads its updated draft before writing', async () => {
  const { disk, store, file, queue } = setup()
  const unregister = registerPendingEditorFlush(file.id, () =>
    store.getState().setEditorDraft(file.id, 'header\nlatest')
  )
  try {
    await queue.queueSave(file, 'header\nstale', 'autosave')
    expect(disk.files.get(file.filePath)).toBe('header\nlatest')
    expect(store.getState().openFiles[0]?.isDirty).toBe(false)
  } finally {
    unregister()
    queue.dispose()
  }
})

it('a failed pending edit prevents the write and keeps the existing dirty draft', async () => {
  const { disk, store, file, queue } = setup()
  const unregister = registerPendingEditorFlush(file.id, () => {
    throw new Error('invalid pending cell')
  })
  try {
    await expect(queue.queueSave(file, 'fallback')).rejects.toThrow('invalid pending cell')
    expect(disk.fs.writeFile).not.toHaveBeenCalled()
    expect(store.getState().editorDrafts[file.id]).toBe('header\nprevious')
    expect(store.getState().openFiles[0]?.isDirty).toBe(true)
  } finally {
    unregister()
    queue.dispose()
  }
})

it('a suspended autosave does not flush a pending cell or write the file', async () => {
  const { disk, store, file, queue } = setup()
  store.getState().setExternalMutation(file.id, 'changed')
  const flush = vi.fn()
  const unregister = registerPendingEditorFlush(file.id, flush)
  try {
    await queue.queueSave(file, 'fallback', 'autosave')
    expect(flush).not.toHaveBeenCalled()
    expect(disk.fs.writeFile).not.toHaveBeenCalled()
  } finally {
    unregister()
    queue.dispose()
  }
})
