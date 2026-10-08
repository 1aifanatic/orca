import { randomUUID } from 'node:crypto'
import bareFs from 'fs'
import fs, { rmSync, writeFileSync } from 'node:fs'
import promiseFs, { writeFile } from 'node:fs/promises'
import os, { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'bun:test'
import {
  clearInheritedAgentStateEnv,
  takeRealAgentHomeWriteViolations
} from '../../../../../config/scripts/vitest-real-agent-home-write-guard'

const file = 'notes/bun-migration/performance/bun-native-five-pure-guard-ci-0bd619-explicit-files/fixtures/filesystem-publication.test.ts'
const missing = () => join(userInfo().homedir, '.codex', 'orca-never-created-' + randomUUID(), 'child')
const savedEnvironment = (names: string[]) => Object.fromEntries(names.map(name => [name, process.env[name]]))
const restoreEnvironment = (saved: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

it('publishes guarded named default bare and promise filesystem APIs', async () => {
  const target = missing()
  try {
    expect(() => writeFileSync(target, 'x')).toThrow(/real-agent-home guard/)
    expect(() => fs.writeFileSync(target, 'x')).toThrow(/real-agent-home guard/)
    expect(() => bareFs.writeFileSync(target, 'x')).toThrow(/real-agent-home guard/)
    await expect(writeFile(target, 'x')).rejects.toThrow(/real-agent-home guard/)
    await expect(promiseFs.writeFile(target, 'x')).rejects.toThrow(/real-agent-home guard/)
    await expect(fs.promises.writeFile(target, 'x')).rejects.toThrow(/real-agent-home guard/)
    expect(fs.existsSync(target)).toBe(false)
    expect(takeRealAgentHomeWriteViolations()).toHaveLength(6)
  } finally {
    takeRealAgentHomeWriteViolations()
  }
})

it('retains every existing mutator target position on missing safe paths', async () => {
  const protectedTarget = missing()
  const absentSource = join(tmpdir(), 'orca-absent-source-' + randomUUID())
  const methods = [
    ['writeFile', [protectedTarget, 'x']], ['appendFile', [protectedTarget, 'x']],
    ['mkdir', [protectedTarget]], ['mkdtemp', [protectedTarget]],
    ['rename', [protectedTarget, absentSource]], ['rename', [absentSource, protectedTarget]],
    ['copyFile', [absentSource, protectedTarget]], ['cp', [absentSource, protectedTarget]],
    ['symlink', [absentSource, protectedTarget]], ['link', [absentSource, protectedTarget]],
    ['rm', [protectedTarget, { force: true }]], ['rmdir', [protectedTarget]],
    ['unlink', [protectedTarget]], ['truncate', [protectedTarget]],
    ['open', [protectedTarget, 'w']]
  ] as const
  try {
    for (const [name, args] of methods) {
      const sync = Reflect.get(fs, name + 'Sync')
      expect(typeof sync).toBe('function')
      expect(() => Reflect.apply(sync, fs, [...args])).toThrow(/real-agent-home guard/)
      const promise = Reflect.get(promiseFs, name)
      expect(typeof promise).toBe('function')
      await expect(Reflect.apply(promise, promiseFs, [...args])).rejects.toThrow(/real-agent-home guard/)
      const callback = Reflect.get(fs, name)
      expect(typeof callback).toBe('function')
      expect(() => Reflect.apply(callback, fs, [...args, () => {}])).toThrow(/real-agent-home guard/)
    }
    expect(fs.existsSync(protectedTarget)).toBe(false)
    expect(takeRealAgentHomeWriteViolations()).toHaveLength(methods.length * 3)
  } finally {
    takeRealAgentHomeWriteViolations()
  }
})

it('keeps real account protection while HOME changes and restores absent-variable fallback', () => {
  const tempHome = fs.mkdtempSync(join(tmpdir(), 'orca-native-guard-home-'))
  const saved = savedEnvironment(['HOME', 'USERPROFILE'])
  try {
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
    expect(homedir()).toBe(tempHome)
    expect(os.homedir()).toBe(tempHome)
    expect(() => rmSync(missing(), { force: true })).toThrow(/real-agent-home guard/)
    delete process.env.HOME
    delete process.env.USERPROFILE
    expect(homedir()).toBe(userInfo().homedir)
    expect(os.homedir()).toBe(userInfo().homedir)
    expect(takeRealAgentHomeWriteViolations()).toHaveLength(1)
  } finally {
    restoreEnvironment(saved)
    takeRealAgentHomeWriteViolations()
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})

it('preserves reads temporary writes sibling prefixes access values and inherited clearing', async () => {
  const tempHome = fs.mkdtempSync(join(tmpdir(), 'orca-native-guard-allowed-'))
  const saved = savedEnvironment(['ORCA_REAL_CLAUDE_CLI_TEST', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ORCA_USER_DATA_PATH', 'ORCA_CODEX_LAUNCH_PREFLIGHT'])
  try {
    expect(() => fs.openSync(missing(), 'r')).toThrow(/ENOENT/)
    expect(() => fs.rmSync(join(userInfo().homedir, '.codex-orca-absent-' + randomUUID()), { force: true })).not.toThrow()
    const allowed = join(tempHome, 'allowed')
    fs.writeFileSync(allowed, 'x')
    await expect(promiseFs.access(allowed)).resolves.toBeUndefined()
    await expect(promiseFs.access(join(tempHome, 'absent'))).rejects.toThrow(/ENOENT/)
    for (const value of [undefined, '', '0', 'true', '1']) {
      if (value === undefined) delete process.env.ORCA_REAL_CLAUDE_CLI_TEST
      else process.env.ORCA_REAL_CLAUDE_CLI_TEST = value
      process.env.CLAUDE_CONFIG_DIR = join(tempHome, 'claude')
      process.env.CODEX_HOME = join(tempHome, 'codex')
      process.env.ORCA_USER_DATA_PATH = join(tempHome, 'orca')
      process.env.ORCA_CODEX_LAUNCH_PREFLIGHT = join(tempHome, 'cli')
      clearInheritedAgentStateEnv()
      expect(process.env.CLAUDE_CONFIG_DIR).toBe(value === '1' ? join(tempHome, 'claude') : undefined)
      for (const name of ['CODEX_HOME', 'ORCA_USER_DATA_PATH', 'ORCA_CODEX_LAUNCH_PREFLIGHT']) expect(process.env[name]).toBeUndefined()
    }
    expect(takeRealAgentHomeWriteViolations()).toEqual([])
    console.log('ORCA_NATIVE_SENTINEL ' + JSON.stringify({ kind: 'fs-publication', file, pid: process.pid, passed: true }))
  } finally {
    restoreEnvironment(saved)
    takeRealAgentHomeWriteViolations()
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})
