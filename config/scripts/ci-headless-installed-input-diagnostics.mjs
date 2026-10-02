import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, openSync, readSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function capturePnpmWorkspaceState({ root, prefix, installed, writeJson }) {
  const path = join(root, 'node_modules/.pnpm-workspace-state-v1.json')
  const metadata = {
    path,
    present: existsSync(path),
    mode: null,
    size: null,
    sha256: null,
    rawFile: null
  }
  if (metadata.present) {
    const stat = lstatSync(path)
    metadata.mode = stat.mode & 0o777
    metadata.size = stat.size
    writeJson(`${prefix}.metadata.json`, metadata)
    assert(stat.isFile(), 'pnpm workspace state must be a regular file')
    assert(stat.size <= 1_048_576, 'pnpm workspace state exceeds snapshot limit')
    const buffer = Buffer.alloc(1_048_577)
    const descriptor = openSync(path, 'r')
    let length = 0
    try {
      while (length < buffer.length) {
        const bytes = readSync(descriptor, buffer, length, buffer.length - length, null)
        if (bytes === 0) {
          break
        }
        length += bytes
      }
    } finally {
      closeSync(descriptor)
    }
    assert(length <= 1_048_576, 'pnpm workspace state exceeds snapshot limit')
    assert.equal(length, stat.size, 'pnpm workspace state size changed during snapshot')
    const content = buffer.subarray(0, length)
    metadata.sha256 = createHash('sha256').update(content).digest('hex')
    metadata.rawFile = `${prefix}.raw.json`
    writeFileSync(metadata.rawFile, content)
  }
  writeJson(`${prefix}.metadata.json`, metadata)
  assert.equal(
    metadata.sha256 ?? undefined,
    installed.entries.find((entry) => entry.path === './.pnpm-workspace-state-v1.json')?.sha256,
    'pnpm workspace state changed during snapshot'
  )
  return metadata
}

export function installedInputChanges(expected, actual) {
  const before = new Map(expected.entries.map((entry) => [entry.path, entry]))
  const after = new Map(actual.entries.map((entry) => [entry.path, entry]))
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
  return paths.flatMap((path) => {
    const previous = before.get(path)
    const current = after.get(path)
    return JSON.stringify(previous) === JSON.stringify(current)
      ? []
      : [
          {
            path,
            change: !previous ? 'added' : !current ? 'removed' : 'changed',
            previous,
            current
          }
        ]
  })
}
