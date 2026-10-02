import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { markCopiedResource } from '../codex/codex-managed-home-resource-copy-marker'
import { carryMirrorOnlyHomeFiles } from './retired-mirror-home-files'

let root = ''
let runtimeHomePath = ''
let systemHomePath = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-mirror-home-files-'))
  runtimeHomePath = join(root, 'mirror')
  systemHomePath = join(root, 'codex')
  mkdirSync(runtimeHomePath, { recursive: true })
  mkdirSync(systemHomePath, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function carry(): boolean {
  return carryMirrorOnlyHomeFiles({ runtimeHomePath, systemHomePath })
}

describe('carryMirrorOnlyHomeFiles', () => {
  it('appends approved command rules ~/.codex lacks, creating the file if needed', () => {
    write(
      join(runtimeHomePath, 'rules', 'default.rules'),
      'prefix_rule(pattern=["git", "status"], decision="allow")\nprefix_rule(pattern=["ls"], decision="allow")\n'
    )
    write(
      join(runtimeHomePath, 'rules', 'team.rules'),
      'prefix_rule(pattern=["make"], decision="allow")\n'
    )
    write(
      join(systemHomePath, 'rules', 'default.rules'),
      'prefix_rule(pattern=["ls"], decision="allow")'
    )

    expect(carry()).toBe(true)
    expect(carry()).toBe(true)

    expect(readFileSync(join(systemHomePath, 'rules', 'default.rules'), 'utf-8')).toBe(
      'prefix_rule(pattern=["ls"], decision="allow")\nprefix_rule(pattern=["git", "status"], decision="allow")\n'
    )
    expect(readFileSync(join(systemHomePath, 'rules', 'team.rules'), 'utf-8')).toBe(
      'prefix_rule(pattern=["make"], decision="allow")\n'
    )
  })

  it('copies pane-installed skills and plugins file by file, never overwriting', () => {
    write(join(runtimeHomePath, 'skills', 'pane-skill', 'SKILL.md'), 'mirror skill')
    write(join(runtimeHomePath, 'skills', 'shared', 'SKILL.md'), 'mirror copy')
    write(join(runtimeHomePath, 'plugins', 'cache', 'tool', 'plugin.json'), '{}')
    write(join(systemHomePath, 'skills', 'shared', 'SKILL.md'), 'user copy')

    expect(carry()).toBe(true)

    expect(readFileSync(join(systemHomePath, 'skills', 'pane-skill', 'SKILL.md'), 'utf-8')).toBe(
      'mirror skill'
    )
    expect(readFileSync(join(systemHomePath, 'skills', 'shared', 'SKILL.md'), 'utf-8')).toBe(
      'user copy'
    )
    expect(existsSync(join(systemHomePath, 'plugins', 'cache', 'tool', 'plugin.json'))).toBe(true)
  })

  it("skips a folder that is a link to ~/.codex or Orca's own copy of it", () => {
    const linkedSource = join(root, 'elsewhere', 'skills')
    write(join(linkedSource, 'linked', 'SKILL.md'), 'linked')
    symlinkSync(linkedSource, join(runtimeHomePath, 'skills'), 'junction')
    write(join(runtimeHomePath, 'plugins', 'removed-by-user', 'plugin.json'), '{}')
    markCopiedResource(runtimeHomePath, 'plugins', join(systemHomePath, 'plugins'))

    expect(carry()).toBe(true)

    expect(existsSync(join(systemHomePath, 'skills'))).toBe(false)
    expect(existsSync(join(systemHomePath, 'plugins'))).toBe(false)
  })

  it('copies prompt history only when ~/.codex has none', () => {
    write(join(runtimeHomePath, 'history.jsonl'), '{"text":"mirror"}\n')

    expect(carry()).toBe(true)
    expect(readFileSync(join(systemHomePath, 'history.jsonl'), 'utf-8')).toBe('{"text":"mirror"}\n')

    write(join(runtimeHomePath, 'history.jsonl'), '{"text":"later"}\n')
    expect(carry()).toBe(true)
    expect(readFileSync(join(systemHomePath, 'history.jsonl'), 'utf-8')).toBe('{"text":"mirror"}\n')
  })
})
