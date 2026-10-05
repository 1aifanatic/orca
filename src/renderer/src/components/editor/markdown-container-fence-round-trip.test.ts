// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { normalizeMarkdownReferenceLinks } from './markdown-reference-link-normalization'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const source = 'graph TD\nA[Line 1<br/>Line 2] --> B'

describe('fenced code in Markdown containers', () => {
  it.each(
    ['```', '~~~'].flatMap((fence) =>
      ['> ', '>> ', '- '].map((prefix) => ({ fence, prefix, label: `${prefix}${fence}` }))
    )
  )('keeps the code source in a $label fence', ({ fence, prefix }) => {
    const continuation = prefix.includes('>') ? prefix : ' '.repeat(prefix.length)
    const markdown = `${prefix}${fence}mermaid\n${continuation}graph TD\n${continuation}A[Line 1<br/>Line 2] --> B\n${continuation}${fence}\n`
    const codec = createRichMarkdownEditorCodec()
    const editor = new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({ codec }),
      content: encodeRawMarkdownHtmlForRichEditor(markdown, codec),
      contentType: 'markdown'
    })
    try {
      const blocks: string[] = []
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'codeBlock') {
          blocks.push(node.textContent)
        }
      })
      expect(blocks).toEqual([source])
      expect(editor.getMarkdown()).toContain('A[Line 1<br/>Line 2] --> B')
      expect(editor.getMarkdown()).not.toContain(codec.transport.authoredPrefix)
    } finally {
      editor.destroy()
    }
  })

  it('preserves authored transport envelopes and document-link syntax as code', () => {
    const codec = createRichMarkdownEditorCodec('0'.repeat(32))
    const source = [
      `${codec.transport.authoredPrefix}inline-html:%3Cbr%2F%3E]]`,
      `[[ORCA_RICH_MD:${'1'.repeat(32)}:inline-html:%3Cbr%2F%3E]]`,
      '[[ORCA_RAW_HTML_INLINE:%3Cbr%2F%3E]]',
      '[[docs|authored link syntax]]'
    ].join('\n')
    const markdown = `> ~~~text\n${source
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}\n> ~~~`
    const encoded = encodeRawMarkdownHtmlForRichEditor(markdown, codec)
    expect(encoded).toBe(markdown)
    const editor = new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({ codec }),
      content: encoded,
      contentType: 'markdown'
    })
    try {
      expect(editor.state.doc.firstChild?.firstChild?.textContent).toBe(source)
      for (const line of source.split('\n')) {
        expect(editor.getMarkdown()).toContain(line)
      }
    } finally {
      editor.destroy()
    }
  })

  it('keeps a reference definition inside list-fenced code', () => {
    const markdown = '- ```mermaid\n  graph TD\n  [docs]: https://example.com/docs\n  ```\n\n[Docs]'
    expect(normalizeMarkdownReferenceLinks(markdown)).toBe(markdown)
  })
})
