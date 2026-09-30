import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Structured chat session code reports every background error through
 * `traceAgentSessionError`. The two shapes it replaced both lost failures in a packaged
 * build: a `console` line (the main process owns no console there) and an optional `on*Error?` sink
 * that no caller had to supply. A catch site reports its own step; a callback it takes carries
 * behavior and is required.
 */
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

/** Directories scanned whole. */
const SCANNED_TREES = [
  'src/main/native-chat/agent-session-wire',
  'src/main/native-chat/agent-session-journal',
  'src/main/native-chat/agent-model-catalog'
]
/** Directories whose files with one of these prefixes are scanned. */
const SCANNED_PREFIXED: readonly { dir: string; prefix: string }[] = [
  { dir: 'src/main/native-chat', prefix: 'structured-agent-session-' },
  { dir: 'src/main/runtime', prefix: 'structured-agent-session-' },
  { dir: 'src/main/runtime/rpc/methods', prefix: 'structured-agent-session-' },
  { dir: 'src/main/claude', prefix: 'claude-structured-' }
]

const CONSOLE_FAILURE =
  /\bconsole\s*(?:\.\s*(?:warn|error)|\[\s*(['"`])(?:warn|error)\1\s*\])(?![\w$])/
const OPTIONAL_ERROR_SINK = /\b(on\w*(?:Error|Failure|Failed))\s*\?\s*[:(]/g

/** Optional because they carry behavior only some callers want, never because a caller may skip
 *  reporting: each failure is also reported, or handled, where it happens. */
const BEHAVIORAL_OPTIONAL_CALLBACKS = new Set([
  // Hands agent-start the acquisition error its refusal is built from; attach-flow reports it too.
  'onAcquisitionFailed',
  // Rejects the start or ends the child; a translator built outside an acquisition has neither.
  'onBackgroundTaskJournalFailure'
])

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
  const prefixed = SCANNED_PREFIXED.flatMap(({ dir, prefix }) =>
    readdirSync(join(REPO_ROOT, dir))
      .filter((entry) => entry.startsWith(prefix))
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

function repoPath(file: string): string {
  return relative(REPO_ROOT, file).split('\\').join('/')
}

function consoleOffenders(files: readonly string[]): string[] {
  return files
    .filter((file) => CONSOLE_FAILURE.test(codeText(readFileSync(file, 'utf8'))))
    .map(repoPath)
}

function optionalSinks(text: string): string[] {
  return [...text.matchAll(OPTIONAL_ERROR_SINK)]
    .map((match) => match[1])
    .filter((name) => !BEHAVIORAL_OPTIONAL_CALLBACKS.has(name))
}

function optionalSinkOffenders(files: readonly string[]): string[] {
  return files.flatMap((file) =>
    optionalSinks(codeText(readFileSync(file, 'utf8'))).map((name) => `${repoPath(file)}: ${name}`)
  )
}

describe('structured chat session background error reporting', () => {
  const files = scannedFiles()

  it('scans a plausible number of files', () => {
    // A moved directory would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(250)
  })

  it('reports failures through the reporter, never the console', () => {
    expect(
      consoleOffenders(files),
      'Call traceAgentSessionError from src/main/observability/agent-session-error-trace instead.'
    ).toEqual([])
  })

  it('declares no optional error sink', () => {
    expect(
      optionalSinkOffenders(files),
      'Report at the catch site; a callback that carries behavior is required.'
    ).toEqual([])
  })

  it('catches both shapes', () => {
    expect(CONSOLE_FAILURE.test("console.warn('x', error)")).toBe(true)
    expect(CONSOLE_FAILURE.test("console['error']('x')")).toBe(true)
    expect(CONSOLE_FAILURE.test('const warn = console.warn')).toBe(true)
    expect(CONSOLE_FAILURE.test("console.info('x')")).toBe(false)
    expect(CONSOLE_FAILURE.test('console.warning')).toBe(false)
    expect(optionalSinks('  onError?: (error: unknown) => void')).toEqual(['onError'])
    expect(optionalSinks('  onEventSinkError?: (input) => void')).toEqual(['onEventSinkError'])
    expect(optionalSinks('  onFailure?: (error: unknown) => void')).toEqual(['onFailure'])
    expect(optionalSinks('  onNoteFailed?(error: unknown): void')).toEqual(['onNoteFailed'])
    expect(optionalSinks('  onAcquisitionFailed?: (error: unknown) => void')).toEqual([])
    expect(optionalSinks('  onError: (error: unknown) => void')).toEqual([])
    expect(optionalSinks('  deps.onError?.(error)')).toEqual([])
    expect(optionalSinks('  const x = onFailure ? a : b')).toEqual([])
  })
})
