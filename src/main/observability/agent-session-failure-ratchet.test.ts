import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Structured chat session code reports every background failure through
 * `reportAgentSessionFailure`. The two shapes it replaced both lost failures in a packaged build:
 * a `console` line (the main process owns no console there) and an optional `on*Error?` sink that
 * no caller had to supply. A catch site reports its own step; a callback it takes carries behavior
 * and is required.
 */
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

/** Directories scanned whole, and directories whose `structured-agent-session-*` files are. */
const SCANNED_TREES = [
  'src/main/native-chat/agent-session-wire',
  'src/main/native-chat/agent-session-journal',
  'src/main/native-chat/agent-model-catalog'
]
const SCANNED_PREFIXED = ['src/main/native-chat', 'src/main/runtime']
const SESSION_FILE_PREFIX = 'structured-agent-session-'

const CONSOLE_FAILURE = /\bconsole\s*\.\s*(?:warn|error)\s*\(/
const OPTIONAL_ERROR_SINK = /\bon\w*Error\s*\?\s*:/

function isProductionSource(path: string): boolean {
  return /\.tsx?$/.test(path) && !/\.(?:test|spec)\.tsx?$/.test(path)
}

function collectTree(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const full = join(root, entry)
    return statSync(full).isDirectory() ? collectTree(full) : [full]
  })
}

function scannedFiles(): string[] {
  const trees = SCANNED_TREES.flatMap((dir) => collectTree(join(REPO_ROOT, dir)))
  const prefixed = SCANNED_PREFIXED.flatMap((dir) =>
    readdirSync(join(REPO_ROOT, dir))
      .filter((entry) => entry.startsWith(SESSION_FILE_PREFIX))
      .map((entry) => join(REPO_ROOT, dir, entry))
      .filter((full) => statSync(full).isFile())
  )
  return [...trees, ...prefixed].filter((full) => isProductionSource(basename(full)))
}

/** Drop comment-only lines so prose about the old idiom is not an offender. */
function codeText(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

function offenders(files: readonly string[], pattern: RegExp): string[] {
  return files
    .filter((file) => pattern.test(codeText(readFileSync(file, 'utf8'))))
    .map((file) => relative(REPO_ROOT, file).split('\\').join('/'))
}

describe('structured chat session failure reporting', () => {
  const files = scannedFiles()

  it('scans a plausible number of files', () => {
    // A moved directory would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(200)
  })

  it('reports failures through the reporter, never the console', () => {
    expect(
      offenders(files, CONSOLE_FAILURE),
      'Call reportAgentSessionFailure from src/main/observability/agent-session-failure instead.'
    ).toEqual([])
  })

  it('declares no optional error sink', () => {
    expect(
      offenders(files, OPTIONAL_ERROR_SINK),
      'Report at the catch site; a callback that carries behavior is required.'
    ).toEqual([])
  })

  it('catches both shapes', () => {
    expect(CONSOLE_FAILURE.test("console.warn('x', error)")).toBe(true)
    expect(CONSOLE_FAILURE.test("console.info('x')")).toBe(false)
    expect(OPTIONAL_ERROR_SINK.test('  onError?: (error: unknown) => void')).toBe(true)
    expect(OPTIONAL_ERROR_SINK.test('  onEventSinkError?: (input) => void')).toBe(true)
    expect(OPTIONAL_ERROR_SINK.test('  onError: (error: unknown) => void')).toBe(false)
    expect(OPTIONAL_ERROR_SINK.test('  deps.onError?.(error)')).toBe(false)
  })
})
