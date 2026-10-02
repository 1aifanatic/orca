import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { TESTS_OUTSIDE_PROGRAM } from '../../mobile/scripts/check-tests-typecheck-ratchet.mjs'
import { runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const workflow = parse(readFileSync(join(root, '.github/workflows/mobile.yml'), 'utf8'))
const steps = workflow.jobs.verify.steps
const production = steps.find((step) => step.id === 'production-types')
const ratchet = steps.find((step) => step.name === 'Typecheck tests (ratchet)')
const mobile = JSON.parse(readFileSync(join(root, 'mobile/package.json'), 'utf8'))
const directories = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function writeFile(directory, file, contents, options) {
  const target = join(directory, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents, options)
}

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-mobile-typecheck-launch-')))
  directories.push(directory)
  writeFile(directory, 'package.json', '{"type":"module"}')
  writeFile(directory, 'tests-typecheck-baseline.txt', 'src/current.test.ts\n')
  for (const file of ['src/current.test.ts', 'src/new.test.ts', ...TESTS_OUTSIDE_PROGRAM.keys()]) {
    writeFile(directory, file, 'export {}\n')
  }
  mkdirSync(join(directory, 'scripts'))
  copyFileSync(
    join(root, 'mobile/scripts/check-tests-typecheck-ratchet.mjs'),
    join(directory, 'scripts/check-tests-typecheck-ratchet.mjs')
  )
  writeFile(directory, 'node_modules/typescript/package.json', '{"name":"typescript"}')
  writeFile(directory, 'node_modules/typescript/bin/tsc', "require('../lib/tsc.js')\n")
  writeFile(
    directory,
    'node_modules/typescript/lib/tsc.js',
    `const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const testPass = args.includes('--listFiles')
fs.writeFileSync(testPass ? 'ratchet-call.json' : 'production-call.json', JSON.stringify({
  args, cwd: process.cwd(), execPath: process.execPath,
  nodeOptions: process.env.NODE_OPTIONS, frozen: process.env.BUNDLE_FROZEN
}))
if (testPass) {
  for (const file of ['src/current.test.ts', 'src/new.test.ts']) console.log(path.resolve(file))
  console.log('src/current.test.ts(1,1): error TS2322: existing failure')
  if (process.env.ORCA_RATCHET_NEW_FAILURE === '1') {
    console.log('src/new.test.ts(1,1): error TS2322: new failure')
  }
  process.exit(2)
}
process.exit(Number(process.env.ORCA_PRODUCTION_EXIT ?? 0))
`
  )
  writeFile(directory, 'bin/pnpm', '#!/bin/sh\nprintf "install\\n" >> installers.log\nexit 73\n', {
    mode: 0o755
  })
  return directory
}

describe('mobile read-only compiler launches', () => {
  it('keeps the frozen install and parallel barrier around the existing compiler scripts', () => {
    expect(mobile.scripts.typecheck).toBe('tsc --noEmit')
    expect(mobile.scripts['check:tests-typecheck']).toBe(ratchet.run)
    expect(production.run).toBe('node node_modules/typescript/bin/tsc --noEmit')
    expect(workflow.jobs.verify.defaults.run['working-directory']).toBe('mobile')
    const install = steps.findIndex((step) => step.run === 'pnpm install --frozen-lockfile')
    const start = steps.indexOf(production)
    const checks = steps.indexOf(ratchet)
    const joinStep = steps.findIndex((step) => step.wait === 'production-types')
    expect(install).toBeGreaterThanOrEqual(0)
    expect(start).toBeGreaterThan(install)
    expect(checks).toBeGreaterThan(start)
    expect(joinStep).toBeGreaterThan(checks)
    expect(steps.findIndex((step) => step.name === 'Test')).toBeGreaterThan(joinStep)
    expect(production.background).toBe(true)
    for (const step of [production, ratchet, steps[joinStep]]) {
      expect(step['continue-on-error']).toBeUndefined()
      expect(step.if).toBeUndefined()
    }
    expect(steps.slice(start, joinStep).filter((step) => step.run)).toHaveLength(2)
  })

  it.skipIf(process.platform === 'win32').each([
    { productionExit: 0, newFailure: '0', ratchetExit: 0 },
    { productionExit: 13, newFailure: '0', ratchetExit: 0 },
    { productionExit: 0, newFailure: '1', ratchetExit: 1 }
  ])('executes both shell commands without installers: %j', (expected) => {
    const directory = fixture()
    const result = runProcessSync({
      program: 'bash',
      args: [
        '-c',
        `
${production.run} > production.out 2>&1 &
production_pid=$!
${ratchet.run} > ratchet.out 2>&1
printf '%s' "$?" > ratchet.exit
wait "$production_pid"
printf '%s' "$?" > production.exit
`
      ],
      cwd: directory,
      timeoutMs: 10_000,
      env: {
        ...process.env,
        PATH: [join(directory, 'bin'), dirname(process.execPath), process.env.PATH].join(delimiter),
        NODE_OPTIONS: '--no-warnings',
        BUNDLE_FROZEN: 'true',
        ORCA_PRODUCTION_EXIT: String(expected.productionExit),
        ORCA_RATCHET_NEW_FAILURE: expected.newFailure
      }
    })
    expect(result.code, result.stderr).toBe(0)
    const installers = existsSync(join(directory, 'installers.log'))
      ? readFileSync(join(directory, 'installers.log'), 'utf8').trim().split('\n').length
      : 0
    expect(installers).toBe(0)
    expect(Number(readFileSync(join(directory, 'production.exit'), 'utf8'))).toBe(
      expected.productionExit
    )
    expect(Number(readFileSync(join(directory, 'ratchet.exit'), 'utf8'))).toBe(expected.ratchetExit)
    for (const [file, args] of [
      ['production-call.json', ['--noEmit']],
      ['ratchet-call.json', ['--noEmit', '--listFiles', '-p', 'tsconfig.test.json']]
    ]) {
      expect(JSON.parse(readFileSync(join(directory, file), 'utf8'))).toEqual({
        args,
        cwd: directory,
        execPath: process.execPath,
        nodeOptions: '--no-warnings',
        frozen: 'true'
      })
    }
    const output = readFileSync(join(directory, 'ratchet.out'), 'utf8')
    expect(output).toContain(
      expected.ratchetExit === 0
        ? '2 test file(s) in the program (4 excluded on purpose, none @ts-nocheck), 1 grandfathered file(s)'
        : 'Test file no longer typechecks: src/new.test.ts'
    )
  })
})
