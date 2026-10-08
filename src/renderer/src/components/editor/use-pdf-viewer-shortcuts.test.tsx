// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { useContext, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorShortcutOwnerContext } from './editor-shortcut-owner'
import { usePdfViewerShortcuts } from './use-pdf-viewer-shortcuts'

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

function PdfViewerStandIn({
  name,
  openFind
}: {
  name: string
  openFind: () => void
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const ownsShortcuts = useContext(EditorShortcutOwnerContext)
  usePdfViewerShortcuts({
    rootRef,
    ownsShortcuts,
    keybindings: undefined,
    openFind,
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomReset: vi.fn()
  })
  return (
    <div ref={rootRef} data-testid={`${name}-pdf`}>
      <canvas />
    </div>
  )
}

/** The real split shape: each group's strip and body (where editors render), and the retained
 *  overlay host for terminals, chats and browsers as a sibling of the layout, outside every body. */
function Workspace({
  focusedGroup,
  openFind
}: {
  focusedGroup: 'pdf' | 'chat' | 'second-pdf' | null
  openFind: Record<'pdf' | 'second-pdf', () => void>
}): React.JSX.Element {
  return (
    <div>
      <div data-tab-group-strip-id="pdf">
        <div tabIndex={0} data-testid="pdf-tab" />
      </div>
      <div data-tab-group-body-id="pdf">
        <EditorShortcutOwnerContext.Provider value={focusedGroup === 'pdf'}>
          <button type="button" data-testid="pdf-header-copy-path" />
          <PdfViewerStandIn name="first" openFind={openFind.pdf} />
        </EditorShortcutOwnerContext.Provider>
      </div>
      <div data-tab-group-body-id="second-pdf">
        <EditorShortcutOwnerContext.Provider value={focusedGroup === 'second-pdf'}>
          <PdfViewerStandIn name="second" openFind={openFind['second-pdf']} />
        </EditorShortcutOwnerContext.Provider>
      </div>
      <div data-tab-group-strip-id="chat" />
      <div data-tab-group-body-id="chat" />
      <div data-testid="retained-overlays">
        <div data-native-chat-root="true">
          <button type="button" data-testid="chat-tool-disclosure" />
        </div>
        <textarea className="xterm-helper-textarea" data-testid="xterm" />
        <button type="button" data-testid="browser-chrome" />
      </div>
      <button type="button" data-testid="explorer-row" />
      <input data-testid="sidebar-search" />
    </div>
  )
}

function setup(focusedGroup: 'pdf' | 'chat' | 'second-pdf' | null) {
  const openFind = { pdf: vi.fn(), 'second-pdf': vi.fn() }
  const view = render(<Workspace focusedGroup={focusedGroup} openFind={openFind} />)
  return { openFind, view }
}

describe('PDF viewer find shortcut', () => {
  it('leaves Mod+F to a chat, terminal or browser whose split is focused', () => {
    const { openFind, view } = setup('chat')
    for (const id of ['chat-tool-disclosure', 'xterm', 'browser-chrome', 'explorer-row']) {
      expect(pressFind(view.getByTestId(id)).defaultPrevented).toBe(false)
    }
    expect(openFind.pdf).not.toHaveBeenCalled()
    expect(openFind['second-pdf']).not.toHaveBeenCalled()
  })

  it('opens from its own tab, its editor header and the file explorer while its group is focused', () => {
    const { openFind, view } = setup('pdf')
    for (const id of ['pdf-tab', 'pdf-header-copy-path', 'explorer-row']) {
      expect(pressFind(view.getByTestId(id)).defaultPrevented).toBe(true)
    }
    expect(pressFind(document.body).defaultPrevented).toBe(true)
    expect(openFind.pdf).toHaveBeenCalledTimes(4)
    // With two PDFs on screen only the focused group's opens.
    expect(openFind['second-pdf']).not.toHaveBeenCalled()
  })

  it('leaves a text field its keys, and always opens from inside the PDF', () => {
    const { openFind, view } = setup('chat')
    expect(pressFind(view.getByTestId('sidebar-search')).defaultPrevented).toBe(false)
    expect(pressFind(view.getByTestId('second-pdf').firstElementChild!).defaultPrevented).toBe(true)
    expect(openFind['second-pdf']).toHaveBeenCalledTimes(1)
    expect(openFind.pdf).not.toHaveBeenCalled()
  })

  it('does not open for a PDF kept mounted in a hidden workspace', () => {
    // A hidden workspace's groups are never the focused group.
    const { openFind } = setup(null)
    expect(pressFind(document.body).defaultPrevented).toBe(false)
    expect(openFind.pdf).not.toHaveBeenCalled()
  })
})
