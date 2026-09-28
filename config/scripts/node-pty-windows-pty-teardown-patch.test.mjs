import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  assertPatchedNodePtyWindowsTeardown,
  patchNodePtyWindowsTeardown
} = require('../relay-assets/node-pty-1.1.0-windows-pty-teardown-patch.cjs')
const projectDir = resolve(import.meta.dirname, '..', '..')
const cleanupDirs = []

const PATCHED_FILES = ['windowsPtyAgent.js', 'windowsTerminal.js']

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Windows SSH relay node-pty ConPTY teardown patch', () => {
  it('releases conin after the console-list fork', () => {
    const fixture = writeNodePtyFixture('1.1.0')
    patchNodePtyWindowsTeardown(fixture.root)
    const patched = readFileSync(join(fixture.libDir, 'windowsPtyAgent.js'), 'utf8')

    const branch = patched.slice(
      patched.indexOf('if (!this._useConptyDll) {'),
      patched.indexOf('else {', patched.indexOf('if (!this._useConptyDll) {'))
    )
    expect(branch).toContain('this._inSocket.destroy();')
    expect(branch.indexOf('this._inSocket.destroy();')).toBeGreaterThan(
      branch.indexOf('this._conoutSocketWorker.dispose();')
    )
    expect(branch.indexOf('this._inSocket.destroy();')).toBeGreaterThan(
      branch.indexOf('this._getConsoleProcessList()')
    )
  })

  it('installs and verifies idempotently', () => {
    const fixture = writeNodePtyFixture('1.1.0')

    patchNodePtyWindowsTeardown(fixture.root)
    const once = PATCHED_FILES.map((file) => readFileSync(join(fixture.libDir, file), 'utf8'))
    for (const file of PATCHED_FILES) {
      expect(existsSync(`${join(fixture.libDir, file)}.orca-patch-${process.pid}`)).toBe(false)
    }
    expect(() => assertPatchedNodePtyWindowsTeardown(fixture.root)).not.toThrow()

    patchNodePtyWindowsTeardown(fixture.root)
    expect(PATCHED_FILES.map((file) => readFileSync(join(fixture.libDir, file), 'utf8'))).toEqual(
      once
    )
  })

  it('refuses a different package version or unexpected source', () => {
    const wrongVersion = writeNodePtyFixture('1.2.0-beta.11')
    expect(() => patchNodePtyWindowsTeardown(wrongVersion.root)).toThrow('expected 1.1.0')

    for (const file of PATCHED_FILES) {
      const drifted = writeNodePtyFixture('1.1.0')
      const path = join(drifted.libDir, file)
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n// drift`)
      expect(() => patchNodePtyWindowsTeardown(drifted.root)).toThrow('unexpected node-pty')
    }
  })

  it('refuses a half-applied tree, so one file cannot pass for both', () => {
    for (const file of PATCHED_FILES) {
      const partial = writeNodePtyFixture('1.1.0')
      const fixture = writeNodePtyFixture('1.1.0')
      patchNodePtyWindowsTeardown(fixture.root)
      writeFileSync(join(partial.libDir, file), readFileSync(join(fixture.libDir, file), 'utf8'))
      expect(() => assertPatchedNodePtyWindowsTeardown(partial.root)).toThrow('is not installed')
    }
  })
})

/** Published upstream bytes keep legacy SSH repair coverage independent of local dependencies. */
function writeNodePtyFixture(version) {
  const root = mkdtempSync(join(projectDir, '.node-pty-teardown-patch-test-'))
  cleanupDirs.push(root)
  const libDir = join(root, 'node_modules', 'node-pty', 'lib')
  mkdirSync(libDir, { recursive: true })
  writeFileSync(join(root, 'node_modules', 'node-pty', 'package.json'), JSON.stringify({ version }))
  for (const file of PATCHED_FILES) {
    writeFileSync(
      join(libDir, file),
      readFileSync(join(import.meta.dirname, 'fixtures/node-pty-1.1.0', `${file}.txt`))
    )
  }
  return { root, libDir }
}
