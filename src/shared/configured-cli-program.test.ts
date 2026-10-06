import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfiguredCliProgram } from './configured-cli-program'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-configured-program-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function stub(relativePath: string, mode = 0o755): string {
  const file = join(root, relativePath)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, mode)
  return file
}

function resolveOn(
  configured: string,
  platform: NodeJS.Platform = 'linux',
  pathEnv = join(root, 'bin')
): string | null {
  return resolveConfiguredCliProgram(configured, { platform, pathEnv, homePath: root })
}

describe.skipIf(process.platform === 'win32')('resolveConfiguredCliProgram', () => {
  it('returns an absolute runnable path as it is', () => {
    const program = stub('tools/agent-wrapper')
    expect(resolveOn(program)).toBe(program)
  })

  it('expands a leading ~ against the launch home', () => {
    const program = stub('.local/agent/claude')
    expect(resolveOn('~/.local/agent/claude')).toBe(program)
  })

  it.each([`"`, `'`])('strips one surrounding pair of %s quotes', (quote) => {
    const program = stub('Agent Tools/claude')
    expect(resolveOn(`  ${quote}${program}${quote} `)).toBe(program)
  })

  it('looks a bare name up on the launch PATH', () => {
    const program = stub('bin/claude-nightly')
    expect(resolveOn('claude-nightly')).toBe(program)
  })

  it('finds a bare name in the install directories when PATH misses it', () => {
    const program = stub('.bun/bin/codex-nightly')
    expect(resolveOn('codex-nightly')).toBe(program)
  })

  it('answers null for a missing program instead of the bare name', () => {
    expect(resolveOn('claude-nightly')).toBeNull()
    expect(resolveOn(join(root, 'missing/claude'))).toBeNull()
  })

  it('answers null for a file that is not executable', () => {
    expect(resolveOn(stub('tools/claude', 0o644))).toBeNull()
  })

  it('answers null for a directory', () => {
    mkdirSync(join(root, 'tools/claude'), { recursive: true })
    expect(resolveOn(join(root, 'tools/claude'))).toBeNull()
  })

  it('answers null for a relative path rather than guessing its base', () => {
    stub('tools/claude')
    expect(resolveOn('./tools/claude')).toBeNull()
    expect(resolveOn('tools/claude')).toBeNull()
  })

  it('answers null for a command line, which is not a program', () => {
    const program = stub('bin/claude')
    expect(resolveOn(`${program} --flag`)).toBeNull()
    expect(resolveOn('claude --flag')).toBeNull()
  })

  it('answers null for an empty or quote-only value', () => {
    expect(resolveOn('   ')).toBeNull()
    expect(resolveOn('""')).toBeNull()
  })

  describe('on Windows', () => {
    it('finds the spawnable sibling of an extensionless path', () => {
      stub('npm/claude')
      const shim = stub('npm/claude.cmd')
      expect(resolveOn(join(root, 'npm/claude'), 'win32')).toBe(shim)
    })

    it('refuses an extensionless file Windows cannot spawn', () => {
      expect(resolveOn(stub('npm/claude'), 'win32')).toBeNull()
    })

    it('skips an extensionless PATH match for a spawnable one later on PATH', () => {
      stub('git-bin/claude')
      const exe = stub('bin/claude.exe')
      expect(
        resolveOn('claude', 'win32', [join(root, 'git-bin'), join(root, 'bin')].join(':'))
      ).toBe(exe)
    })

    it.each(['claude.exe', 'claude.com', 'claude.cmd', 'claude.bat'])(
      'accepts an explicit %s path',
      (name) => {
        const program = stub(`tools/${name}`)
        expect(resolveOn(program, 'win32')).toBe(program)
      }
    )
  })
})
