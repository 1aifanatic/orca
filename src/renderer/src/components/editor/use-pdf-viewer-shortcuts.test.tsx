// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pdfViewerOwnsFind, usePdfViewerShortcuts } from './use-pdf-viewer-shortcuts'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

function pressFind(target: EventTarget): KeyboardEvent {
  const isMac = navigator.userAgent.includes('Mac')
  const event = new KeyboardEvent('keydown', {
    key: 'f',
    code: 'KeyF',
    bubbles: true,
    cancelable: true,
    metaKey: isMac,
    ctrlKey: !isMac
  })
  target.dispatchEvent(event)
  return event
}

function mountPdf(): { root: HTMLDivElement; openFind: () => void } {
  const root = document.createElement('div')
  root.append(document.createElement('canvas'))
  document.body.append(root)
  const openFind = vi.fn()
  renderHook(() =>
    usePdfViewerShortcuts({
      rootRef: { current: root },
      keybindings: undefined,
      openFind,
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      zoomReset: vi.fn()
    })
  )
  return { root, openFind }
}

describe('PDF viewer find shortcut', () => {
  it('leaves Mod+F pressed in another surface, such as a chat, to that surface', () => {
    const { openFind } = mountPdf()
    const chatComposer = document.createElement('textarea')
    document.body.append(chatComposer)
    expect(pressFind(chatComposer).defaultPrevented).toBe(false)
    expect(openFind).not.toHaveBeenCalled()
  })

  it('opens from inside the PDF, or with nothing focused while the PDF is on screen', () => {
    const { root, openFind } = mountPdf()
    expect(pressFind(root.firstElementChild!).defaultPrevented).toBe(true)
    expect(pressFind(document.body).defaultPrevented).toBe(true)
    expect(openFind).toHaveBeenCalledTimes(2)
  })

  it('does not open for a PDF kept mounted in a hidden workspace', () => {
    const root = document.createElement('div')
    const hiddenSurface = document.createElement('div')
    hiddenSurface.style.display = 'none'
    hiddenSurface.append(root)
    document.body.append(hiddenSurface)
    expect(pdfViewerOwnsFind(root, document.body)).toBe(false)
    hiddenSurface.style.display = ''
    hiddenSurface.style.opacity = '0'
    expect(pdfViewerOwnsFind(root, document.body)).toBe(false)
  })
  it('opens from its own tab or the file explorer, not from a chat or another group', () => {
    const groupBody = (id: string): HTMLElement => {
      const body = document.createElement('div')
      body.dataset.tabGroupBodyId = id
      return body
    }
    const strip = (id: string): HTMLElement => {
      const element = document.createElement('div')
      element.dataset.tabGroupStripId = id
      const tab = document.createElement('div')
      tab.tabIndex = 0
      element.append(tab)
      return element
    }
    const pdfGroup = groupBody('g1')
    const root = document.createElement('div')
    pdfGroup.append(root)
    const ownStrip = strip('g1')
    const otherStrip = strip('g2')
    const chatGroup = groupBody('g2')
    const chatComposer = document.createElement('div')
    chatComposer.setAttribute('data-native-chat-root', 'true')
    chatGroup.append(chatComposer)
    const explorerRow = document.createElement('button')
    const sidebarSearch = document.createElement('input')
    document.body.append(ownStrip, pdfGroup, otherStrip, chatGroup, explorerRow, sidebarSearch)

    expect(pdfViewerOwnsFind(root, ownStrip.firstElementChild)).toBe(true)
    expect(pdfViewerOwnsFind(root, explorerRow)).toBe(true)
    expect(pdfViewerOwnsFind(root, otherStrip.firstElementChild)).toBe(false)
    expect(pdfViewerOwnsFind(root, chatComposer)).toBe(false)
    expect(pdfViewerOwnsFind(root, sidebarSearch)).toBe(false)
  })
})
