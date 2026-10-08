import remend from 'remend'
import type { Nodes } from 'mdast'
import { markdownBlockParser } from './markdown-block-parser'

// Fenced code and directives already have their own streaming parser rules.
const BYPASS_REPAIR = /^(?:[ \t]*(?:>|[-+*]|\d{1,9}[.)]))*[ \t]*(?:::[a-zA-Z]|`{3}|~{3})/mu

function isEscapedDelimiter(text: string, index: number): boolean {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) {
    slashes += 1
  }
  return slashes % 2 === 1
}

function lastLeaf(node: Nodes): Nodes {
  const child = 'children' in node ? node.children.at(-1) : undefined
  return child ? lastLeaf(child) : node
}

function withoutBareOpener(text: string): string {
  const marker = /([*_`]+)\s*$/.exec(text)
  if (
    !marker ||
    isEscapedDelimiter(text, marker.index) ||
    (marker[1]?.startsWith('_') && /[\p{L}\p{N}]/u.test(text[marker.index - 1] ?? ''))
  ) {
    return text
  }
  const leaf = lastLeaf(markdownBlockParser.parse(text))
  // A closing delimiter belongs to its formatted node; an empty opener remains raw text.
  return leaf.type === 'text' && (leaf.position?.end.offset ?? 0) > marker.index
    ? text.slice(0, marker.index)
    : text
}

function closeCodeSpan(text: string): string {
  let openDelimiterLength = 0
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '`' || (openDelimiterLength === 0 && isEscapedDelimiter(text, index))) {
      continue
    }
    let end = index + 1
    while (text[end] === '`') {
      end += 1
    }
    const length = end - index
    if (openDelimiterLength === 0) {
      openDelimiterLength = length
    } else if (length === openDelimiterLength) {
      openDelimiterLength = 0
    }
    index = end - 1
  }
  return openDelimiterLength === 0 ? text : `${text}${'`'.repeat(openDelimiterLength)}`
}

export function repairStreamingMarkdownTail(text: string): string {
  if (BYPASS_REPAIR.test(text)) {
    return text
  }
  return remend(withoutBareOpener(closeCodeSpan(text)), {
    linkMode: 'text-only',
    comparisonOperators: false,
    htmlTags: false,
    katex: false,
    setextHeadings: false,
    singleTilde: false
  })
}
