import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'

function createEditor(markdown: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(markdown, codec),
    contentType: 'markdown'
  })
}

function findRawInlineNodes(editor: Editor): ProseMirrorNode[] {
  const nodes: ProseMirrorNode[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'rawMarkdownHtmlInline') {
      nodes.push(node)
    }
  })
  return nodes
}

function renderTag(node: ProseMirrorNode): string {
  const spec = node.type.spec.toDOM?.(node)
  return Array.isArray(spec) ? String(spec[0]) : ''
}

const TABLE_WITH_BREAKS =
  '| Field | Description |\n' +
  '| --- | --- |\n' +
  '| verdict | Values:<br/><br/>`normal`<br>`defect` |\n'

describe('raw markdown <br> line breaks in the rich editor', () => {
  it('renders <br> and <br/> inside a table cell as real line breaks, not literal text', () => {
    const editor = createEditor(TABLE_WITH_BREAKS)
    try {
      const breakNodes = findRawInlineNodes(editor)
      expect(breakNodes.length).toBeGreaterThan(0)
      // Every <br>/<br/> in the cell renders as an actual <br> element so the
      // values appear on their own lines rather than as raw "<br>" text.
      for (const node of breakNodes) {
        expect(renderTag(node)).toBe('br')
      }
    } finally {
      editor.destroy()
    }
  })

  it('keeps non-break inline HTML as an inert literal span', () => {
    const editor = createEditor('Before <span>hi</span> after\n')
    try {
      const [spanNode] = findRawInlineNodes(editor)
      expect(spanNode).toBeDefined()
      expect(renderTag(spanNode)).toBe('span')
    } finally {
      editor.destroy()
    }
  })

  it('round-trips the verbatim <br> tags in a table cell on save', () => {
    const editor = createEditor(TABLE_WITH_BREAKS)
    try {
      const output = (editor as Editor & { getMarkdown(): string }).getMarkdown()
      expect(output).toContain('<br/>')
      expect(output).toContain('<br>')
      // The break must not silently collapse into a space on serialization.
      expect(output).not.toContain('`normal` `defect`')
    } finally {
      editor.destroy()
    }
  })
})
