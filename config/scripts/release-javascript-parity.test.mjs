import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  annotateJavascriptParityFiles,
  compareJavascriptParityFiles,
  equivalentStylesheets
} from './release-javascript-parity.mjs'

const directories = []
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
)

function inventory(entries) {
  const root = mkdtempSync(join(tmpdir(), 'orca-release-parity-'))
  directories.push(root)
  const files = Object.entries(entries).map(([path, content]) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
    return { path, sha256: createHash('sha256').update(content).digest('hex') }
  })
  return annotateJavascriptParityFiles(root, files)
}

it('allows one decimal unit of native P3 rounding and its asset reference hashes', () => {
  const before = inventory({
    'renderer/assets/theme-AAAAAAAA.css': '.x{color:color(display-p3 .134023 .230646 .695537)}',
    'renderer/assets/index-BBBBBBBB.js': 'import "./theme-AAAAAAAA.css";run()',
    'renderer/index.html': '<script src="assets/index-BBBBBBBB.js"></script>'
  })
  const after = inventory({
    'renderer/assets/theme-CCCCCCCC.css': '.x{color:color(display-p3 .134023 .230647 .695537)}',
    'renderer/assets/index-DDDDDDDD.js': 'import "./theme-CCCCCCCC.css";run()',
    'renderer/index.html': '<script src="assets/index-DDDDDDDD.js"></script>'
  })
  expect(compareJavascriptParityFiles(before, after)).toEqual([])
})

it('rejects meaningful color changes and every non-color stylesheet change', () => {
  expect(
    equivalentStylesheets(
      'a{color:color(display-p3 .1 .2 .3)}',
      'a{color:color(display-p3 .1 .20001 .3)}'
    )
  ).toBe(false)
  expect(equivalentStylesheets('a{padding:1px}', 'a{padding:2px}')).toBe(false)
  expect(equivalentStylesheets('a{color:red}', 'b{color:red}')).toBe(false)
  expect(
    equivalentStylesheets(
      'a{color:color(display-p3 .1 .2 .3)}',
      'a{color:color(display-p3 .1 .2 .3 / .5)}'
    )
  ).toBe(false)
})

it('rejects code changes, missing files and incorrect asset references', () => {
  const before = inventory({ 'renderer/assets/index-AAAAAAAA.js': 'run()' })
  const after = inventory({ 'renderer/assets/index-BBBBBBBB.js': 'other()' })
  expect(compareJavascriptParityFiles(before, after)).toEqual(['renderer/assets/index.js'])
  expect(compareJavascriptParityFiles(before, [])).toEqual(['renderer/assets/index.js'])
  const reference = inventory({
    'renderer/assets/index-BBBBBBBB.js': 'run()',
    'renderer/index.html': '<script src="assets/missing-CCCCCCCC.js"></script>'
  })
  expect(
    compareJavascriptParityFiles(
      reference,
      inventory({
        'renderer/assets/index-DDDDDDDD.js': 'run()',
        'renderer/index.html': '<script src="assets/index-DDDDDDDD.js"></script>'
      })
    )
  ).toEqual(['renderer/index.html'])
})

it('keeps ambiguous asset names and portable binary files exact', () => {
  const before = inventory({
    'renderer/assets/App-AAAAAAAA.js': 'run()',
    'renderer/assets/App-BBBBBBBB.js': 'other()',
    'renderer/viewer.wasm': 'one'
  })
  expect(before.map((file) => file.comparablePath)).toEqual(before.map((file) => file.path))
  expect(
    compareJavascriptParityFiles(
      before,
      inventory({
        'renderer/assets/App-AAAAAAAA.js': 'run()',
        'renderer/assets/App-BBBBBBBB.js': 'other()',
        'renderer/viewer.wasm': 'two'
      })
    )
  ).toEqual(['renderer/viewer.wasm'])
})
