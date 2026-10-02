import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Readers open other apps' databases synchronously, so only the worker thread
 * may call them. This keeps a reader from being imported onto the main thread.
 */
const ALLOWED_IMPORTERS = new Set([
  'src/main/foreign-sqlite-readers/foreign-sqlite-reader-entry.ts',
  'src/main/foreign-sqlite-readers/foreign-sqlite-reader-dispatch.ts'
])
const READERS_DIRECTORY = 'src/main/foreign-sqlite-readers/readers/'
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'build', '.git'])
const SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.mock\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm

function collectSourceFiles(root: string): string[] {
  let found: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      found = found.concat(collectSourceFiles(full))
    } else if (SCANNED_EXTENSIONS.some((extension) => full.endsWith(extension))) {
      found.push(full)
    }
  }
  return found
}

function toRepoPath(repoRoot: string, path: string): string {
  return relative(repoRoot, path).split('\\').join('/')
}

function importsReaders(repoRoot: string, file: string): boolean {
  for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? ''
    const target = specifier.startsWith('.')
      ? toRepoPath(repoRoot, resolve(dirname(file), specifier))
      : specifier
    if (`${target}/`.includes(READERS_DIRECTORY)) {
      return true
    }
  }
  return false
}

describe('foreign SQLite readers import boundary', () => {
  const repoRoot = resolve(__dirname, '..', '..', '..')
  const files = [
    ...collectSourceFiles(join(repoRoot, 'src')),
    ...collectSourceFiles(join(repoRoot, 'config')),
    ...collectSourceFiles(join(repoRoot, 'tests'))
  ]
  const importers = files
    .filter((file) => !toRepoPath(repoRoot, file).startsWith(READERS_DIRECTORY))
    .filter((file) => importsReaders(repoRoot, file))
    .map((file) => toRepoPath(repoRoot, file))

  it('scans a plausible number of files', () => {
    // A broken root or extension list would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(500)
  })

  it('finds the importers it allows', () => {
    // Presence check: a pattern that matched nothing would pass the next test trivially.
    expect(importers).toContain('src/main/foreign-sqlite-readers/foreign-sqlite-reader-dispatch.ts')
  })

  it('has no importer outside the worker entry and its dispatch', () => {
    expect(
      importers.filter((path) => !ALLOWED_IMPORTERS.has(path)),
      'Readers run only on the foreign SQLite reader worker; call them through foreign-sqlite-reader-spawn.ts.'
    ).toEqual([])
  })
})
