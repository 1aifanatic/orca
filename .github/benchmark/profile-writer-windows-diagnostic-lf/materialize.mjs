// Source-bound diagnostic materialization only; launches no tests.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [phase, codeArgument] = process.argv.slice(2)
assert.ok(['before', 'after'].includes(phase))
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
for (const key of ['ORCA_VITEST_RUNTIME', 'ORCA_PROFILE_STALL_TIMEOUT_MS', 'NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE']) assert.equal(process.env[key], undefined, key)
const payload = resolve(import.meta.dirname, 'payload')
const hash = value => createHash('sha256').update(value).digest('hex')
const manifestBytes = readFileSync(resolve(payload, 'definition-manifest.json'))
const manifest = JSON.parse(manifestBytes)
const { runProcessSync } = await import(pathToFileURL(resolve('config/scripts/script-child-process.mjs')).href)
const command = args => {
  const result = runProcessSync({ program: 'git', args, timeoutMs: 10000, maxOutputBytes: 2097152 })
  assert.equal(result.code, 0)
  assert.equal(result.outputTruncated, false)
  return result.stdout.trim()
}
assert.equal(command(['rev-parse', 'HEAD']), manifest.sourceHead)
assert.equal(process.env.WRITER_DIAGNOSTIC_SOURCE_SHA, manifest.sourceHead)
assert.deepEqual(command(['show', '-s', '--format=%P', 'HEAD']).split(' '), manifest.sourceParents)
assert.equal(command(['config', '--get', 'core.autocrlf']), 'false', 'Require explicit LF checkout policy')
assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
for (const [file, expected] of Object.entries(manifest.sourceHashes)) {
  assert.ok(!file.startsWith('notes/'))
  const wanted = phase === 'after' && file === manifest.target ? manifest.targetAfterSha256 : expected
  assert.equal(hash(readFileSync(file)), wanted, file)
}
const { NODE_RUNTIME_PIN } = await import(pathToFileURL(resolve('src/shared/node-runtime-pin.ts')).href)
assert.equal(process.versions.node, manifest.expectedCiPins.node)
assert.equal(NODE_RUNTIME_PIN.version, manifest.expectedCiPins.node)
assert.equal(JSON.parse(readFileSync('node_modules/vitest/package.json')).version, manifest.expectedCiPins.vitest)
assert.equal(JSON.parse(readFileSync('node_modules/electron/package.json')).version, manifest.expectedCiPins.electron)
for (const [name, expected] of Object.entries(manifest.payloadSha256)) {
  assert.ok(!name.includes('/') && !name.includes('\\'))
  assert.equal(hash(readFileSync(resolve(payload, name))), expected)
}
const directory = manifest.isolatedDirectory
if (phase === 'before') {
  assert.equal(command(['diff', '--name-only', 'HEAD']), '')
  for (const name of Object.keys(manifest.payloadSha256)) {
    const destination = resolve(directory, name)
    assert.equal(existsSync(destination), false)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(resolve(payload, name), destination, constants.COPYFILE_EXCL)
  }
  const result = runProcessSync({ program: 'git', args: ['apply', '--check', resolve(directory, 'diagnostic-only.patch')], timeoutMs: 10000, maxOutputBytes: 65536 })
  assert.equal(result.code, 0)
  const applied = runProcessSync({ program: 'git', args: ['apply', resolve(directory, 'diagnostic-only.patch')], timeoutMs: 10000, maxOutputBytes: 65536 })
  assert.equal(applied.code, 0)
  for (const [file, expected] of Object.entries(manifest.sourceHashes)) assert.equal(hash(readFileSync(file)), file === manifest.target ? manifest.targetAfterSha256 : expected, file)
  assert.equal(command(['diff', '--name-only', 'HEAD']), manifest.target)
  const context = {
    sourceSha: manifest.sourceHead, sourceParents: command(['show', '-s', '--format=%P', 'HEAD']).split(' '),
    definitionSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    sourceCheckoutPolicy: 'Explicit CI-only core.autocrlf=false before both checkouts',
    platform: process.platform, arch: process.arch, nodeVersion: process.versions.node,
    vitestVersion: manifest.expectedCiPins.vitest, electronVersion: manifest.expectedCiPins.electron,
    manifestSha256: hash(manifestBytes), reporterSha256: manifest.reporterSha256, sourceHashes: manifest.sourceHashes, targetAfterSha256: manifest.targetAfterSha256,
    diffSha256: hash(command(['diff', '--binary', 'HEAD'])), background: process.env.ORCA_BACKGROUND_LAUNCH,
    commandArgs: ['exec', 'vitest', 'run', '--config', 'config/vitest.config.ts', ...manifest.files, '--reporter=default', '--reporter=json', `--reporter=./${directory}/persistence-import-reuse-benchmark-reporter.mjs`, `--outputFile=${directory}/report.json`],
    diagnosticOnlyNeverMerge: true, testsLaunchedByMaterializer: false
  }
  writeFileSync(resolve(directory, 'ci-context.json'), JSON.stringify(context, null, 2) + '\n', { flag: 'wx' })
} else {
  assert.match(codeArgument, /^\d+$/)
  const context = JSON.parse(readFileSync(resolve(directory, 'ci-context.json')))
  assert.equal(command(['diff', '--name-only', 'HEAD']), manifest.target)
  assert.equal(hash(command(['diff', '--binary', 'HEAD'])), context.diffSha256)
  const result = { exitCode: Number(codeArgument), sourceUnchanged: true, targetAfterSha256: manifest.targetAfterSha256, sourceSha: manifest.sourceHead, diffSha256: context.diffSha256, normalForegroundCommandReturnObserved: true, processTreeAbsenceClaim: false, newCleanupSignals: false }
  writeFileSync(resolve(directory, 'command-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
}
