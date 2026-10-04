// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusRichMarkdownEditorFromSearch } from './rich-markdown-search-focus'

function createSurface() {
  const root = document.createElement('div')
  root.className = 'rich-markdown-editor-shell'
  const editorDom = document.createElement('div')
  editorDom.contentEditable = 'true'
  editorDom.tabIndex = -1
  const paragraph = document.createElement('p')
  paragraph.textContent = 'First editable paragraph'
  editorDom.append(paragraph)
  const search = document.createElement('div')
  search.className = 'rich-markdown-search'
  const findInput = document.createElement('input')
  const replaceInput = document.createElement('input')
  search.append(findInput, replaceInput)
  root.append(editorDom, search)
  document.body.append(root)
  const focus = vi.spyOn(editorDom, 'focus')
  root.addEventListener('mousedown', (event) => {
    if (event instanceof MouseEvent) {
      focusRichMarkdownEditorFromSearch(event, editorDom)
    }
  })
  return { root, editorDom, paragraph, findInput, replaceInput, focus }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('rich markdown search focus handoff', () => {
  it.each(['find', 'replace'] as const)(
    'returns keyboard focus from %s without preventing native selection or requesting scroll',
    (field) => {
      const { paragraph, editorDom, findInput, replaceInput, focus } = createSurface()
      const input = field === 'find' ? findInput : replaceInput
      input.focus()
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })

      paragraph.dispatchEvent(event)

      expect(document.activeElement).toBe(editorDom)
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
      expect(event.defaultPrevented).toBe(false)
    }
  )

  it('leaves an existing document selection intact for Shift click or drag', () => {
    const { paragraph, editorDom, findInput } = createSurface()
    const text = paragraph.firstChild
    if (!text) {
      throw new Error('expected editable paragraph text')
    }
    const selection = document.getSelection()
    const range = document.createRange()
    range.setStart(text, 2)
    range.setEnd(text, 9)
    selection?.addRange(range)
    findInput.focus()
    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      shiftKey: true
    })

    paragraph.dispatchEvent(event)

    expect(document.activeElement).toBe(editorDom)
    expect(selection?.anchorNode).toBe(text)
    expect(selection?.anchorOffset).toBe(2)
    expect(selection?.focusNode).toBe(text)
    expect(selection?.focusOffset).toBe(9)
    expect(event.defaultPrevented).toBe(false)
  })

  it.each(['button', 'input', 'textarea', 'select', 'noneditable', 'task-label'])(
    'leaves embedded %s controls in charge of focus',
    (kind) => {
      const { editorDom, findInput, focus } = createSurface()
      const control = document.createElement(
        kind === 'noneditable' ? 'div' : kind === 'task-label' ? 'label' : kind
      )
      if (kind === 'noneditable' || kind === 'task-label') {
        control.setAttribute('contenteditable', 'false')
      }
      const child = document.createElement('span')
      control.append(child)
      editorDom.append(control)
      findInput.focus()

      child.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))

      expect(document.activeElement).toBe(findInput)
      expect(focus).not.toHaveBeenCalled()
    }
  )

  it('does not steal focus from a different editor find widget or unrelated field', () => {
    const first = createSurface()
    const second = createSurface()
    const unrelated = document.createElement('input')
    document.body.append(unrelated)

    for (const input of [second.findInput, unrelated]) {
      input.focus()
      first.paragraph.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      expect(document.activeElement).toBe(input)
    }

    expect(first.focus).not.toHaveBeenCalled()
  })

  it('leaves ordinary editor clicks and blank surface clicks untouched', () => {
    const { root, editorDom, paragraph, findInput, focus } = createSurface()
    editorDom.focus()
    focus.mockClear()
    paragraph.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    findInput.focus()
    root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))

    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(findInput)
  })

  it('leaves canceled and non-primary presses untouched', () => {
    const { paragraph, findInput, focus } = createSurface()
    findInput.focus()
    const canceled = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    canceled.preventDefault()

    for (const event of [
      canceled,
      new MouseEvent('mousedown', { bubbles: true, button: 1 }),
      new MouseEvent('mousedown', { bubbles: true, button: 2 })
    ]) {
      paragraph.dispatchEvent(event)
    }

    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(findInput)
  })

  it('allows editable content nested inside an unrelated noneditable ancestor', () => {
    const { root, paragraph, findInput, focus } = createSurface()
    root.setAttribute('contenteditable', 'false')
    findInput.focus()

    paragraph.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))

    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
  })

  it('does nothing when the editor has not mounted', () => {
    focusRichMarkdownEditorFromSearch(new MouseEvent('mousedown', { button: 0 }), null)
  })
})
