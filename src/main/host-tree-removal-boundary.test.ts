import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard the recursive-delete chokepoint at the tree level rather than per call site.
 *
 * An async recursive `rm` queues every entry of the tree on libuv's shared 4-thread pool, so every
 * other async fs call in the process waits behind the whole tree. A trashed worktree held chat sends
 * in the main process for minutes that way. `removeHostTree` deletes off that pool; this test is what
 * stops the next call site from going around it.
 */
const OWNER_FILES = new Set(['src/main/host-tree-removal.ts', 'src/main/tree-removal-worker.ts'])
const SCANNED_ROOTS = ['src/main', 'src/shared']
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  '__fixtures__'
])

function isTestFile(path: string): boolean {
  return (
    /\.(?:test|spec|bench)\.tsx?$/.test(path) ||
    /(?:test-harness|test-utils|test-setup|test-fixture|test-support|test-rig|fixture|repro)/.test(
      path
    ) ||
    path.includes('/__tests__/') ||
    path.includes('/__mocks__/')
  )
}

function collectSourceFiles(root: string): string[] {
  let found: string[] = []
  for (const entry of readdirSync(root)) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      found = found.concat(collectSourceFiles(full))
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      found.push(full)
    }
  }
  return found
}

/** Drop comment-only lines so prose about the old idiom is not an offender. */
function codeText(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

function callArguments(text: string, openParen: number): string {
  let depth = 0
  for (let index = openParen; index < text.length; index++) {
    if (text[index] === '(') {
      depth += 1
    } else if (text[index] === ')') {
      depth -= 1
      if (depth === 0) {
        return text.slice(openParen + 1, index)
      }
    }
  }
  return text.slice(openParen + 1)
}

/** The call's second argument, split at the first top-level comma. */
function optionsArgument(args: string): string {
  let depth = 0
  for (let index = 0; index < args.length; index++) {
    const char = args[index]
    if ('([{'.includes(char)) {
      depth += 1
    } else if (')]}'.includes(char)) {
      depth -= 1
    } else if (char === ',' && depth === 0) {
      return args.slice(index + 1).trim()
    }
  }
  return ''
}

function isRecursiveOptions(args: string, source: string): boolean {
  const options = optionsArgument(args)
  if (/recursive\s*:\s*false\b/.test(options)) {
    return false
  }
  if (/\brecursive\b/.test(options)) {
    return true
  }
  // Options built by a call cannot be read here, so they must prove they are not a recursive delete.
  if (/^[\w$.]+\s*\(/.test(options)) {
    return true
  }
  // Options held in a same-file constant: `const REMOVE_OPTIONS = { recursive: true, ... }`.
  const identifier = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(options)?.[1]
  if (!identifier) {
    return false
  }
  const declaration = new RegExp(`\\b${identifier}\\b[^=\\n]*=\\s*\\{([^}]*)\\}`).exec(source)
  return declaration !== null && /recursive\s*:\s*true/.test(declaration[1])
}

/** Async (promise or callback) `rm`/`rmdir` calls that delete recursively. `rmSync` is not matched. */
function findRecursiveAsyncRemovals(source: string): string[] {
  const code = codeText(source)
  const offenders: string[] = []
  const callPattern = /(?<![\w$])(?:[\w$]+\.)*(rm|rmdir)\s*\(/g
  for (const match of code.matchAll(callPattern)) {
    const openParen = match.index + match[0].length - 1
    const args = callArguments(code, openParen)
    if (isRecursiveOptions(args, code)) {
      offenders.push(`${match[0]}${args.replace(/\s+/g, ' ').slice(0, 80)})`)
    }
  }
  return offenders
}

describe('recursive removal boundary', () => {
  const repoRoot = resolve(__dirname, '..', '..')
  const files = SCANNED_ROOTS.flatMap((root) => collectSourceFiles(join(repoRoot, root)))
    .map((file) => relative(repoRoot, file).split('\\').join('/'))
    .filter((path) => !isTestFile(path) && !OWNER_FILES.has(path))

  it('scans a plausible number of files', () => {
    // A broken root or extension list would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(1000)
  })

  it('recognizes every recursive-delete shape and ignores the rest', () => {
    expect(
      findRecursiveAsyncRemovals(`await rm(dir, { recursive: true, force: true })`)
    ).toHaveLength(1)
    expect(
      findRecursiveAsyncRemovals(
        `await fs.promises.rm(\n  dir,\n  {\n    force: true,\n    recursive: true\n  }\n)`
      )
    ).toHaveLength(1)
    expect(
      findRecursiveAsyncRemovals(
        `const OPTS = { recursive: true, force: true }\nawait rm(dir, OPTS)`
      )
    ).toHaveLength(1)
    expect(
      findRecursiveAsyncRemovals(`await rm(target, { recursive: isDir, force: true })`)
    ).toHaveLength(1)
    expect(findRecursiveAsyncRemovals(`fs.rmdir(dir, { recursive: true }, done)`)).toHaveLength(1)
    expect(findRecursiveAsyncRemovals(`await rm(dir, removalOptions())`)).toHaveLength(1)
    expect(findRecursiveAsyncRemovals(`fs.rmdir(dir, done)`)).toEqual([])
    expect(findRecursiveAsyncRemovals(`await rm(join(root, name), { force: true })`)).toEqual([])
    expect(findRecursiveAsyncRemovals(`await rm(file, { force: true })`)).toEqual([])
    expect(findRecursiveAsyncRemovals(`rmSync(dir, { recursive: true, force: true })`)).toEqual([])
    expect(findRecursiveAsyncRemovals(`await removeHostTree(dir)`)).toEqual([])
    expect(findRecursiveAsyncRemovals(`// await rm(dir, { recursive: true })`)).toEqual([])
  })

  it('routes every async recursive delete through removeHostTree', () => {
    const offenders = files.flatMap((path) =>
      findRecursiveAsyncRemovals(readFileSync(join(repoRoot, path), 'utf8')).map(
        (call) => `${path}: ${call}`
      )
    )
    expect(
      offenders,
      'Async recursive rm floods the shared fs thread pool. Use removeHostTree from src/main/host-tree-removal.'
    ).toEqual([])
  })
})
