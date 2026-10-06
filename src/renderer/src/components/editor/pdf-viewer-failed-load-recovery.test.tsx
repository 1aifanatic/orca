// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PdfViewer from './PdfViewer'
import { pdfViewPositionCache } from '@/lib/scroll-cache'

const getDocument = vi.hoisted(() => vi.fn())
const shownDocuments = vi.hoisted((): unknown[] => [])
const viewers = vi.hoisted((): { currentScale: number; currentScaleValue: string }[] => [])
const eventBuses = vi.hoisted(
  (): { dispatch: (name: string, event: { location?: unknown; scale: number }) => void }[] => []
)
const scrollDestinations = vi.hoisted((): unknown[] => [])
const viewerSignals = vi.hoisted((): AbortSignal[] => [])

vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument }))
vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => {
  class EventBus {
    listeners = new Map<string, Set<(event: { location?: unknown; scale: number }) => void>>()
    constructor() {
      eventBuses.push(this)
    }
    on(name: string, callback: (event: { location?: unknown; scale: number }) => void): void {
      const listeners = this.listeners.get(name) ?? new Set()
      listeners.add(callback)
      this.listeners.set(name, listeners)
    }
    off(name: string, callback: (event: { location?: unknown; scale: number }) => void): void {
      this.listeners.get(name)?.delete(callback)
    }
    dispatch(name: string, event: { location?: unknown; scale: number }): void {
      for (const callback of this.listeners.get(name) ?? []) {
        callback(event)
      }
    }
  }
  class PDFLinkService {
    setViewer(): void {}
    setDocument(): void {}
  }
  class PDFFindController {
    setDocument(): void {}
  }
  class PDFViewer {
    pagesCount = 10
    currentScale = 1
    currentScaleValue = 'page-width'
    constructor(options: { abortSignal?: AbortSignal }) {
      viewers.push(this)
      if (options.abortSignal) {
        viewerSignals.push(options.abortSignal)
      }
    }
    setDocument(doc: unknown): void {
      shownDocuments.push(doc)
    }
    scrollPageIntoView(destination: unknown): void {
      scrollDestinations.push(destination)
    }
    update(): void {}
  }
  return { EventBus, PDFLinkService, PDFFindController, PDFViewer }
})
vi.mock('pdfjs-dist/web/pdf_viewer.css', () => ({}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => '' }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { keybindings: Record<string, never> }) => unknown) =>
    selector({ keybindings: {} })
}))

const ERROR_TEXT = 'Failed to load PDF preview'

function loadingTask(doc: object | 'fail'): {
  promise: Promise<unknown>
  destroy: ReturnType<typeof vi.fn<() => Promise<void>>>
} {
  return {
    promise:
      doc === 'fail' ? Promise.reject(new Error('Invalid PDF structure')) : Promise.resolve(doc),
    destroy: vi.fn(() => Promise.resolve())
  }
}

function pendingTask(): {
  promise: Promise<unknown>
  resolve: (doc: object) => void
  destroy: ReturnType<typeof vi.fn<() => Promise<void>>>
} {
  let resolve: (doc: object) => void = () => {}
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { promise, resolve, destroy: vi.fn(() => Promise.resolve()) }
}

async function finishTask(task: ReturnType<typeof pendingTask>, doc: object): Promise<void> {
  await act(async () => {
    task.resolve(doc)
    await task.promise
  })
}

afterEach(() => {
  cleanup()
  getDocument.mockReset()
  shownDocuments.length = 0
  viewers.length = 0
  eventBuses.length = 0
  scrollDestinations.length = 0
  viewerSignals.length = 0
  pdfViewPositionCache.clear()
  localStorage.clear()
})

describe('PdfViewer when the file is rewritten', () => {
  it('loads the next version of the file instead of staying on the error', async () => {
    const finished = { name: 'finished' }
    getDocument
      .mockImplementationOnce(() => loadingTask('fail'))
      .mockImplementationOnce(() => loadingTask(finished))
    const view = render(<PdfViewer content={btoa('%PDF half-written')} filePath="out/main.pdf" />)
    await waitFor(() => expect(view.queryByText(ERROR_TEXT)).toBeTruthy())

    view.rerender(<PdfViewer content={btoa('%PDF finished %%EOF')} filePath="out/main.pdf" />)

    await waitFor(() => expect(view.queryByText(ERROR_TEXT)).toBeNull())
    expect(shownDocuments.at(-1)).toBe(finished)
  })

  it('keeps showing the last good version while a rebuild writes a broken one', async () => {
    const previous = { name: 'previous build' }
    const next = { name: 'next build' }
    getDocument
      .mockImplementationOnce(() => loadingTask(previous))
      .mockImplementationOnce(() => loadingTask('fail'))
      .mockImplementationOnce(() => loadingTask(next))
    const view = render(<PdfViewer content={btoa('%PDF v1')} filePath="out/main.pdf" />)
    await waitFor(() => expect(shownDocuments.at(-1)).toBe(previous))

    view.rerender(<PdfViewer content={btoa('%PDF v2 half-written')} filePath="out/main.pdf" />)
    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.queryByText(ERROR_TEXT)).toBeNull()
    expect(shownDocuments.at(-1)).toBe(previous)

    view.rerender(<PdfViewer content={btoa('%PDF v2 finished')} filePath="out/main.pdf" />)
    await waitFor(() => expect(shownDocuments.at(-1)).toBe(next))
  })

  it('does not keep another file on screen when the newly opened one fails', async () => {
    getDocument
      .mockImplementationOnce(() => loadingTask({ name: 'a.pdf' }))
      .mockImplementationOnce(() => loadingTask('fail'))
    const view = render(<PdfViewer content={btoa('%PDF a')} filePath="a.pdf" />)
    await waitFor(() => expect(shownDocuments.length).toBe(1))

    view.rerender(<PdfViewer content={btoa('%PDF b broken')} filePath="b.pdf" />)

    await waitFor(() => expect(view.queryByText(ERROR_TEXT)).toBeTruthy())
    expect(shownDocuments.at(-1)).toBeNull()
  })

  it('aborts a load that a newer write supersedes, exactly once', async () => {
    const pending = {
      promise: new Promise<unknown>(() => {}),
      destroy: vi.fn(() => Promise.resolve())
    }
    const next = { name: 'next build' }
    getDocument
      .mockImplementationOnce(() => pending)
      .mockImplementationOnce(() => loadingTask(next))
    const view = render(<PdfViewer content={btoa('%PDF v1 slow')} filePath="out/main.pdf" />)

    view.rerender(<PdfViewer content={btoa('%PDF v2')} filePath="out/main.pdf" />)

    await waitFor(() => expect(shownDocuments.at(-1)).toBe(next))
    expect(pending.destroy).toHaveBeenCalledTimes(1)
  })

  it('keeps the document when its own file reads empty mid-rebuild', async () => {
    const previous = { name: 'previous build' }
    getDocument.mockImplementationOnce(() => loadingTask(previous))
    const view = render(<PdfViewer content={btoa('%PDF v1')} filePath="out/main.pdf" />)
    await waitFor(() => expect(shownDocuments.at(-1)).toBe(previous))

    view.rerender(<PdfViewer content="" filePath="out/main.pdf" />)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(shownDocuments.at(-1)).toBe(previous)
    expect(view.queryByText(ERROR_TEXT)).toBeNull()
  })

  it('does not keep another file on screen when the newly opened one is empty', async () => {
    getDocument.mockImplementationOnce(() => loadingTask({ name: 'a.pdf' }))
    const view = render(<PdfViewer content={btoa('%PDF a')} filePath="a.pdf" />)
    await waitFor(() => expect(shownDocuments.length).toBe(1))

    view.rerender(<PdfViewer content="" filePath="empty.pdf" />)

    await waitFor(() => expect(shownDocuments.at(-1)).toBeNull())
    expect(view.queryByText(ERROR_TEXT)).toBeNull()
  })

  it('recovers after invalid base64 without remounting the preview container', async () => {
    const finished = { name: 'finished' }
    getDocument.mockImplementationOnce(() => loadingTask(finished))
    const view = render(<PdfViewer content="%%%" filePath="out/main.pdf" />)
    await waitFor(() => expect(view.queryByText('Failed to decode PDF content')).toBeTruthy())
    const container = view.container.querySelector('.pdfViewer')

    view.rerender(<PdfViewer content={btoa('%PDF finished')} filePath="out/main.pdf" />)

    await waitFor(() => expect(shownDocuments.at(-1)).toBe(finished))
    expect(view.queryByText('Failed to decode PDF content')).toBeNull()
    expect(view.container.querySelector('.pdfViewer')).toBe(container)
  })

  it('recovers from a password error and destroys the rejected task', async () => {
    const failed = {
      promise: Promise.reject(
        Object.assign(new Error('Password required'), { name: 'PasswordException' })
      ),
      destroy: vi.fn(() => Promise.resolve())
    }
    const finished = { name: 'finished' }
    getDocument
      .mockImplementationOnce(() => failed)
      .mockImplementationOnce(() => loadingTask(finished))
    const view = render(<PdfViewer content={btoa('%PDF encrypted')} filePath="out/main.pdf" />)
    await waitFor(() => expect(view.queryByText('This PDF is password-protected')).toBeTruthy())

    view.rerender(<PdfViewer content={btoa('%PDF finished')} filePath="out/main.pdf" />)

    await waitFor(() => expect(shownDocuments.at(-1)).toBe(finished))
    expect(view.queryByText('This PDF is password-protected')).toBeNull()
    expect(failed.destroy).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      label: 'file path',
      filePath: 'b.pdf',
      preferenceKey: 'owner-a',
      scrollCacheKey: 'a:pdf',
      sameBytes: false
    },
    {
      label: 'file path with identical bytes',
      filePath: 'b.pdf',
      preferenceKey: 'owner-a',
      scrollCacheKey: 'a:pdf',
      sameBytes: true
    },
    {
      label: 'execution owner with identical paths and bytes',
      filePath: 'a.pdf',
      preferenceKey: 'owner-b',
      scrollCacheKey: 'a:pdf',
      sameBytes: true
    },
    {
      label: 'scroll scope with identical paths and bytes',
      filePath: 'a.pdf',
      preferenceKey: 'owner-a',
      scrollCacheKey: 'b:pdf',
      sameBytes: true
    }
  ])(
    'clears the old document while loading another $label',
    async ({ filePath, preferenceKey, scrollCacheKey, sameBytes }) => {
      const previous = { name: 'previous' }
      const previousTask = loadingTask(previous)
      const nextTask = pendingTask()
      getDocument.mockImplementationOnce(() => previousTask).mockImplementationOnce(() => nextTask)
      const view = render(
        <PdfViewer
          content={btoa('%PDF a')}
          filePath="a.pdf"
          preferenceKey="owner-a"
          scrollCacheKey="a:pdf"
        />
      )
      await waitFor(() => expect(shownDocuments.at(-1)).toBe(previous))

      view.rerender(
        <PdfViewer
          content={btoa(sameBytes ? '%PDF a' : '%PDF b')}
          filePath={filePath}
          preferenceKey={preferenceKey}
          scrollCacheKey={scrollCacheKey}
        />
      )

      expect(shownDocuments.at(-1)).toBeNull()
      expect(previousTask.destroy).toHaveBeenCalledTimes(1)
      expect(getDocument).toHaveBeenCalledTimes(2)
      const next = { name: 'next' }
      await finishTask(nextTask, next)
      expect(shownDocuments.at(-1)).toBe(next)
    }
  )

  it('ignores out-of-order results and destroys every superseded task once', async () => {
    const first = pendingTask()
    const second = pendingTask()
    const third = pendingTask()
    getDocument
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second)
      .mockImplementationOnce(() => third)
    const view = render(<PdfViewer content={btoa('%PDF first')} filePath="out/main.pdf" />)
    view.rerender(<PdfViewer content={btoa('%PDF second')} filePath="out/main.pdf" />)
    view.rerender(<PdfViewer content={btoa('%PDF third')} filePath="out/main.pdf" />)
    const newest = { name: 'newest' }
    await finishTask(third, newest)
    await finishTask(second, { name: 'obsolete second' })
    await finishTask(first, { name: 'obsolete first' })

    expect(shownDocuments.filter((doc) => doc !== null)).toEqual([newest])
    view.unmount()
    for (const task of [first, second, third]) {
      expect(task.destroy).toHaveBeenCalledTimes(1)
    }
  })

  it('destroys a parsed task when closed before React commits the result', async () => {
    const task = pendingTask()
    getDocument.mockImplementationOnce(() => task)
    const view = render(<PdfViewer content={btoa('%PDF document')} filePath="out/main.pdf" />)

    await act(async () => {
      task.resolve({ name: 'parsed' })
      await task.promise
      view.unmount()
    })

    expect(task.destroy).toHaveBeenCalledTimes(1)
  })

  it.each(['pending', 'displayed'] as const)(
    'destroys a $0 task exactly once on close',
    async (phase) => {
      const task = pendingTask()
      getDocument.mockImplementationOnce(() => task)
      const view = render(<PdfViewer content={btoa('%PDF document')} filePath="out/main.pdf" />)
      if (phase === 'displayed') {
        await finishTask(task, { name: 'displayed' })
      }

      view.unmount()
      if (phase === 'pending') {
        await finishTask(task, { name: 'closed' })
      }

      expect(task.destroy).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps the displayed task alive while loading and releases it after replacement', async () => {
    const previous = { name: 'previous' }
    const previousTask = loadingTask(previous)
    let shownOnDestroy: unknown
    previousTask.destroy.mockImplementation(() => {
      shownOnDestroy = shownDocuments.at(-1)
      return Promise.resolve()
    })
    const nextTask = pendingTask()
    getDocument.mockImplementationOnce(() => previousTask).mockImplementationOnce(() => nextTask)
    const view = render(
      <PdfViewer
        content={btoa('%PDF previous')}
        filePath="out/main.pdf"
        scrollCacheKey="main:pdf"
      />
    )
    await waitFor(() => expect(shownDocuments.at(-1)).toBe(previous))
    eventBuses.at(-1)?.dispatch('pagesinit', { scale: 1 })
    view.rerender(
      <PdfViewer content={btoa('%PDF next')} filePath="out/main.pdf" scrollCacheKey="main:pdf" />
    )
    expect(shownDocuments.at(-1)).toBe(previous)
    expect(previousTask.destroy).not.toHaveBeenCalled()
    expect(viewerSignals.at(-1)?.aborted).toBe(false)

    fireEvent.click(view.getByTitle('Zoom in'))
    const position = { pageNumber: 7, top: 420, left: 12 }
    eventBuses.at(-1)?.dispatch('updateviewarea', { scale: 1.25, location: position })
    const next = { name: 'next' }
    await finishTask(nextTask, next)
    eventBuses.at(-1)?.dispatch('pagesinit', { scale: 1.25 })

    expect(viewers.at(-1)?.currentScale).toBe(1.25)
    expect(previousTask.destroy).toHaveBeenCalledTimes(1)
    expect(viewerSignals[0]?.aborted).toBe(true)
    expect(shownOnDestroy).toBe(next)
    expect(pdfViewPositionCache.get('main:pdf')).toEqual(position)
    expect(scrollDestinations.at(-1)).toMatchObject({
      pageNumber: 7,
      destArray: [null, { name: 'XYZ' }, 12, 420, null]
    })
    view.unmount()
    expect(nextTask.destroy).toHaveBeenCalledTimes(1)
    expect(viewerSignals.every((signal) => signal.aborted)).toBe(true)
  })

  it('owns tasks across StrictMode effect replay', async () => {
    const tasks: ReturnType<typeof pendingTask>[] = []
    getDocument.mockImplementation(() => {
      const task = pendingTask()
      tasks.push(task)
      return task
    })
    const view = render(
      <StrictMode>
        <PdfViewer content={btoa('%PDF document')} filePath="out/main.pdf" />
      </StrictMode>
    )
    expect(tasks).toHaveLength(2)
    const active = tasks.at(-1)
    expect(active).toBeDefined()
    if (active) {
      await finishTask(active, { name: 'active' })
    }

    view.unmount()
    for (const task of tasks) {
      expect(task.destroy).toHaveBeenCalledTimes(1)
    }
  })
})
