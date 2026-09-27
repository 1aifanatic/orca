import { isDeepStrictEqual } from 'node:util'
import { isMap, isNode, isSeq, parseDocument } from 'yaml'
import type { Node, YAMLMap } from 'yaml'

type SourceEdit = { start: number; end: number; text: string }

function columnAt(source: string, offset: number): number {
  return offset - source.lastIndexOf('\n', offset - 1) - 1
}

function indentFragment(fragment: string, difference: number): string {
  return fragment.replace(
    /\n( *)(?=\S)/g,
    (_match, spaces: string) => `\n${' '.repeat(Math.max(0, spaces.length + difference))}`
  )
}

function requireRange(node: unknown): [number, number, number] {
  if (!isNode(node) || !node.range) {
    throw new Error('Missing Hermes YAML source range')
  }
  return node.range
}

function insertPair(
  source: string,
  printed: string,
  parent: YAMLMap,
  updated: YAMLMap,
  key: string,
  enclosing: YAMLMap = parent
): SourceEdit {
  const pair = updated.items.find((item) => isNode(item.key) && item.key.toJSON() === key)
  if (!pair) {
    throw new Error(`Missing Hermes YAML key: ${key}`)
  }
  const keyRange = requireRange(pair.key)
  const valueRange = requireRange(pair.value)
  const parentRange = requireRange(parent)
  if (parent.flow) {
    const position = parentRange[1] - 1
    if (source[position] !== '}') {
      throw new Error('Unexpected Hermes flow mapping boundary')
    }
    const tail =
      parent.srcToken?.type === 'flow-collection' ? parent.srcToken.items.at(-1) : undefined
    const trailingComma =
      tail?.key === undefined &&
      tail?.sep === undefined &&
      tail?.value === undefined &&
      tail?.start.some((token) => token.type === 'comma')
    const separator = parent.items.length > 0 && !trailingComma ? ', ' : ' '
    // A flow closing brace may be outdented farther than an inserted entry or comma.
    const minimumColumn = enclosing.flow ? 0 : columnAt(source, requireRange(enclosing)[0]) + 1
    const column = columnAt(source, position)
    const linePrefix = source.slice(position - column, position)
    const spacesBeforeTab = /^( *)\t[ \t]*$/.exec(linePrefix)?.[1]?.length
    // Tabs are separation, so insufficient leading spaces require a fresh indented line.
    const padding =
      spacesBeforeTab !== undefined && spacesBeforeTab < minimumColumn
        ? `\n${' '.repeat(minimumColumn)}`
        : ' '.repeat(Math.max(0, minimumColumn - column))
    return {
      start: position,
      end: position,
      text: padding + separator + printed.slice(keyRange[0], valueRange[1])
    }
  }
  const column = columnAt(source, parentRange[0])
  const fragment = printed.slice(keyRange[0], valueRange[2])
  const prefix = parentRange[1] > 0 && source[parentRange[1] - 1] !== '\n' ? '\n' : ''
  const text = `${prefix}${' '.repeat(column)}${indentFragment(fragment, column - columnAt(printed, keyRange[0]))}`
  return {
    start: parentRange[1],
    end: parentRange[1],
    text: text.endsWith('\n') ? text : `${text}\n`
  }
}

export function applyHermesPluginSourceEdits(source: string, printed: string): string {
  const original = parseDocument(source, { keepSourceTokens: true })
  const updated = parseDocument(printed)
  if (!isMap(original.contents)) {
    return source.includes('\r\n') ? printed.replaceAll('\n', '\r\n') : printed
  }
  if (!isMap(updated.contents)) {
    throw new Error('Missing updated Hermes mapping')
  }
  const plugins = original.get('plugins', true)
  const updatedPlugins = updated.get('plugins', true)
  if (!isMap(updatedPlugins)) {
    throw new Error('Missing updated Hermes plugins')
  }
  const edits: SourceEdit[] = []
  if (plugins === undefined) {
    edits.push(insertPair(source, printed, original.contents, updated.contents, 'plugins'))
  } else {
    if (!isMap(plugins)) {
      throw new Error('Unexpected Hermes plugins mapping')
    }
    for (const key of ['enabled', 'disabled']) {
      const previous = plugins.get(key, true)
      const next = updatedPlugins.get(key, true)
      if (!isNode(next)) {
        continue
      }
      if (previous === undefined) {
        edits.push(insertPair(source, printed, plugins, updatedPlugins, key, original.contents))
      } else if (isNode(previous) && !isDeepStrictEqual(previous.toJSON(), next.toJSON())) {
        edits.push(replaceNode(source, printed, plugins, previous, next))
      }
    }
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  let result = source
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result =
      result.slice(0, edit.start) + edit.text.replaceAll('\n', newline) + result.slice(edit.end)
  }
  return result
}

function replaceNode(
  source: string,
  printed: string,
  parent: YAMLMap,
  previous: Node,
  next: Node
): SourceEdit {
  const before = requireRange(previous)
  const after = requireRange(next)
  const column = columnAt(source, before[0])
  // Empty flow lists cannot use a block sequence's indentless position.
  const replacementColumn =
    isSeq(previous) && !previous.flow && isSeq(next) && next.flow
      ? Math.max(column, columnAt(source, requireRange(parent)[0]) + 2)
      : column
  const difference = replacementColumn - columnAt(printed, after[0])
  return {
    start: before[0],
    end: before[2],
    text:
      ' '.repeat(replacementColumn - column) +
      indentFragment(printed.slice(after[0], after[2]), difference)
  }
}
