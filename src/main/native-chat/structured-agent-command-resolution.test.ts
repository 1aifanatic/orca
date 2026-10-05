import { accessSync, chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveStructuredAgentCommand } from './structured-agent-command-resolution'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, statSync: vi.fn(actual.statSync), accessSync: vi.fn(actual.accessSync) }
})

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-custom-command-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
function program(name = 'wrapper') {
  const file = join(root, name)
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)
  return file
}
function resolve(override: string, cwd = root) {
  return resolveStructuredAgentCommand({
    agent: 'claude',
    override,
    cwd,
    env: { HOME: root, PATH: root },
    platform: 'linux'
  })
}

describe('custom program resolution on the execution host', () => {
  it.each(['wrapper code', '~/wrapper code', './wrapper code'])(
    'resolves %s with host PATH/home/cwd',
    (override) => {
      const file = program()
      expect(resolve(override)).toEqual({ command: file, prefixArgs: ['code'], cwd: root })
    }
  )
  it('resolves a relative program from the workspace root', () => {
    const file = program()
    expect(resolve('./wrapper', root)).toEqual({ command: file, prefixArgs: [], cwd: root })
  })
  it('keeps quoted absolute paths and empty arguments', () => {
    const file = program('wrapper with spaces')
    expect(resolve(`"${file}" ""`)).toEqual({ command: file, prefixArgs: [''], cwd: root })
  })
  it.each(['missing-program', 'a_shell_alias', 'KEY=value wrapper', 'wrapper && echo done'])(
    'refuses %s without substituting a default',
    (override) => {
      expect(() => resolve(override)).toThrow(
        expect.objectContaining({ reason: 'customCommandInvalid' })
      )
    }
  )
  it('refuses a nonexecutable file', () => {
    const file = program()
    chmodSync(file, 0o644)
    expect(() => resolve(file)).toThrow(expect.objectContaining({ reason: 'customCommandInvalid' }))
  })
  it.each(['sh', 'env'])('refuses shell or environment replacement through %s', (name) => {
    const file = program(name)
    expect(() => resolve(`"${file}" -c 'echo x'`)).toThrow(
      expect.objectContaining({ reason: 'customCommandInvalid' })
    )
  })
  it('retains an explicit Windows shim path for the shared spawn resolver', () => {
    const stat = statSync(program())
    vi.mocked(statSync).mockReturnValue(stat)
    vi.mocked(accessSync).mockImplementation(() => {})
    expect(
      resolveStructuredAgentCommand({
        agent: 'codex',
        override: '"C:\\Agent Tools\\codex.cmd" --profile work',
        env: { USERPROFILE: 'C:\\Users\\Host' },
        platform: 'win32'
      })
    ).toEqual({
      command: 'C:\\Agent Tools\\codex.cmd',
      prefixArgs: ['--profile', 'work']
    })
  })
})
