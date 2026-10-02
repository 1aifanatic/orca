import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync
} from 'node:fs'
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

export function captureCompilerCacheWarmup({
  stage,
  root,
  directory,
  installed,
  sources,
  identity,
  writeJson
}) {
  const current = { identity, sources, installed }
  capturePnpmWorkspaceState({
    root,
    prefix: join(directory, `pnpm-workspace-state-${stage}`),
    installed,
    writeJson
  })
  writeJson(join(directory, `${stage}.json`), current)
  if (stage === 'before') {
    return
  }
  assert.equal(stage, 'after')
  const previous = JSON.parse(readFileSync(join(directory, 'before.json'), 'utf8'))
  const changes = installedInputChanges(previous.installed, installed)
  const proof = {
    before: { sha256: previous.installed.sha256, count: previous.installed.count },
    after: { sha256: installed.sha256, count: installed.count },
    changes
  }
  writeJson(join(directory, 'diff.json'), proof)
  assert.deepEqual(identity, previous.identity, 'Native warmup changed runner identity')
  assert.deepEqual(sources, previous.sources, 'Native warmup changed source inputs')
  for (const change of changes) {
    assert.equal(change.change, 'added', 'Native warmup changed a pre-existing installed input')
    assert.match(
      change.path,
      /^\.\/\.pnpm\/node-gyp@12\.3\.0\/node_modules\/node-gyp\/gyp\/pylib\/(?:gyp|gyp\/generator|packaging)\/__pycache__(?:\/[^/]+\.cpython-\d+\.pyc)?$/
    )
    assert.equal(change.current.type, change.path.endsWith('__pycache__') ? 'directory' : 'file')
  }
  return proof
}
