import type { CodexTrustEntry } from './config-toml-trust'
import {
  computeCodexTrustedHash,
  computeCodexTrustKey,
  normalizeCodexHookTrustLookupKey,
  normalizeCodexTrustSourcePath,
  parseCodexTrustKey,
  usesWindowsCodexPathSeparators
} from './codex-trust-identity'
import {
  ensureHooksStateParentTable,
  findAllHookTrustBlocks,
  findHookTrustBlockRanges,
  type HookTrustBlockRange
} from './config-toml-hook-trust-blocks'
import { escapeTomlBasicString } from './config-toml-syntax'
import { applyCheckedCodexConfigTomlEdit } from './codex-config-toml-checked-edit'
import {
  readTomlAssignmentValue,
  scanTomlStructure,
  tomlKeyPathsEqual
} from './codex-config-toml-structure'

export function upsertHookTrustContent(
  existingContent: string,
  entries: readonly CodexTrustEntry[]
): string {
  const existing = stripLeadingBom(existingContent)
  const writes = entries.map((entry) => ({
    keys: getTrustKeyWriteVariants(computeCodexTrustKey(entry)),
    hash: entry.trustedHash ?? computeCodexTrustedHash(entry),
    explicitEnabled: entry.enabled
  }))
  const needsParentTable = entries.some((entry) =>
    usesWindowsCodexPathSeparators(normalizeCodexTrustSourcePath(entry.sourcePath))
  )
  const updated = applyCheckedCodexConfigTomlEdit(
    existing,
    (content) => {
      let next = needsParentTable ? ensureHooksStateParentTable(content) : content
      for (const write of writes) {
        next = upsertTrustBlocks(next, write.keys, write.hash, write.explicitEnabled)
      }
      return {
        content: next,
        ownedPaths: getOwnedHookStatePaths(
          content,
          writes.flatMap((write) => write.keys)
        ),
        expected: writes.flatMap((write) =>
          write.keys.map((key) => ({
            path: ['hooks', 'state', key, 'trusted_hash'],
            value: write.hash
          }))
        )
      }
    },
    {
      collapsesOwnedDuplicates: (content) =>
        stripHookTrustBlocks(
          content,
          new Set(writes.flatMap((write) => write.keys).map(normalizeCodexHookTrustLookupKey))
        )
    }
  )
  return updated === existing ? existingContent : updated
}

function stripHookTrustBlocks(content: string, normalizedKeys: ReadonlySet<string>): string {
  let cursor = 0
  let stripped = ''
  for (const range of findHookTrustBlockRanges(content, normalizedKeys)) {
    stripped += content.slice(cursor, range.start)
    cursor = range.end
  }
  return stripped + content.slice(cursor)
}

export function removeHookTrustContent(content: string, keys: readonly string[]): string {
  const normalizedKeys = new Set(keys.map(normalizeCodexHookTrustLookupKey))
  if (findHookTrustBlockRanges(content, normalizedKeys).length === 0) {
    return content
  }
  return applyCheckedCodexConfigTomlEdit(
    content,
    (input) => ({
      content: stripHookTrustBlocks(input, normalizedKeys),
      ownedPaths: getOwnedHookStatePaths(input, keys)
    }),
    { collapsesOwnedDuplicates: (input) => stripHookTrustBlocks(input, normalizedKeys) }
  )
}

/** Sets `enabled` on existing hooks.state tables only; a missing table stays missing. */
export function setHookTrustEnabledContent(
  existingContent: string,
  states: readonly { key: string; enabled: boolean }[]
): string {
  const existing = stripLeadingBom(existingContent)
  const updated = applyCheckedCodexConfigTomlEdit(existing, (content) => {
    let next = content
    for (const { key, enabled } of states) {
      next = setEnabledInTrustBlocks(next, key, enabled)
    }
    return {
      content: next,
      ownedPaths: getOwnedHookStatePaths(
        content,
        states.map((state) => state.key)
      ).map((path) => [...path, 'enabled'])
    }
  })
  return updated === existing ? existingContent : updated
}

function setEnabledInTrustBlocks(content: string, key: string, enabled: boolean): string {
  const ranges = findHookTrustBlockRanges(content, new Set([normalizeCodexHookTrustLookupKey(key)]))
  let next = content
  for (const range of ranges.toReversed()) {
    const enabledLine = scanTomlStructure(next.slice(range.contentStart, range.end)).find(
      (line) => line.kind === 'assignment' && tomlKeyPathsEqual(line.keySegments, ['enabled'])
    )
    if (enabledLine?.kind === 'assignment') {
      const valueStart = range.contentStart + enabledLine.lineStart + enabledLine.valueOffset
      const token = /^(?:true|false)/.exec(next.slice(valueStart))
      if (token) {
        next = `${next.slice(0, valueStart)}${enabled}${next.slice(valueStart + token[0].length)}`
      }
    } else if (!enabled) {
      const eol = next.includes('\r\n') ? '\r\n' : '\n'
      next = `${next.slice(0, range.contentStart)}enabled = false${eol}${next.slice(range.contentStart)}`
    }
  }
  return next
}

/** The written keys plus every spelling of them the edit replaces. */
function getOwnedHookStatePaths(content: string, keys: readonly string[]): string[][] {
  const normalized = new Set(keys.map(normalizeCodexHookTrustLookupKey))
  const owned = new Set(keys)
  for (const block of findAllHookTrustBlocks(content)) {
    if (normalized.has(normalizeCodexHookTrustLookupKey(block.key))) {
      owned.add(block.key)
    }
  }
  return [...owned].map((key) => ['hooks', 'state', key])
}

function upsertTrustBlocks(
  content: string,
  keys: readonly string[],
  hash: string,
  explicitEnabled?: boolean
): string {
  const ranges = findHookTrustBlockRanges(
    content,
    new Set(keys.map(normalizeCodexHookTrustLookupKey))
  )
  if (ranges.length === 0) {
    return appendTrustBlocks(content, keys, hash, explicitEnabled ?? true)
  }
  const enabled = explicitEnabled ?? !ranges.some((range) => isBlockDisabled(content, range))
  const block = buildTrustBlocks(keys, hash, enabled)
  let cursor = 0
  let deduped = ''
  ranges.forEach((range, index) => {
    deduped += content.slice(cursor, range.start)
    if (index === 0) {
      deduped += `${block}\n`
    }
    cursor = range.end
  })
  return deduped + content.slice(cursor)
}

function isBlockDisabled(content: string, range: HookTrustBlockRange): boolean {
  return scanTomlStructure(content.slice(range.contentStart, range.end)).some(
    (line) =>
      line.kind === 'assignment' &&
      tomlKeyPathsEqual(line.keySegments, ['enabled']) &&
      readTomlAssignmentValue(line) === false
  )
}

function appendTrustBlocks(
  content: string,
  keys: readonly string[],
  hash: string,
  enabled: boolean
): string {
  const block = buildTrustBlocks(keys, hash, enabled)
  if (content.length === 0) {
    return `${block}\n`
  }
  const separator = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n'
  return `${content}${separator}${block}\n`
}

function buildTrustBlocks(keys: readonly string[], hash: string, enabled: boolean): string {
  return keys.map((key) => buildTrustBlock(key, hash, enabled)).join('\n\n')
}

function buildTrustBlock(key: string, hash: string, enabled: boolean): string {
  return [
    `[hooks.state.${formatHookStateTableKey(key)}]`,
    `enabled = ${enabled}`,
    `trusted_hash = "${escapeTomlBasicString(hash)}"`
  ].join('\n')
}

function formatHookStateTableKey(key: string): string {
  const parsed = parseCodexTrustKey(key)
  if (parsed && usesWindowsCodexPathSeparators(parsed.sourcePath) && !key.includes("'")) {
    return `'${key}'`
  }
  return `"${escapeTomlBasicString(key)}"`
}

function getTrustKeyWriteVariants(key: string): string[] {
  const parsed = parseCodexTrustKey(key)
  if (!parsed || !usesWindowsCodexPathSeparators(parsed.sourcePath)) {
    return [key]
  }
  const suffix = `:${parsed.eventLabel}:${parsed.groupIndex}:${parsed.handlerIndex}`
  return [
    `${parsed.sourcePath.replace(/\//g, '\\')}${suffix}`,
    `${parsed.sourcePath.replace(/\\/g, '/')}${suffix}`
  ].filter((variant, index, variants) => variants.indexOf(variant) === index)
}

function stripLeadingBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}
