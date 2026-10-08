// Replace only the reviewed disposable-CI framework file; break pnpm store hardlinks.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(process.platform, 'linux')
assert.equal(process.arch, 'arm64')
const directory = import.meta.dirname
const plan = JSON.parse(readFileSync(resolve(directory, 'shipping-launch-plan.json')))
assert.equal(process.env.SHARED_SERVER_SOURCE_SHA, plan.sourceHead)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const framework = plan.frameworkCorrection
assert.equal(hash(readFileSync(resolve(directory, 'framework-correction.patch'))), framework.patchSha256)
assert.equal(hash(readFileSync(import.meta.filename)), framework.applierSha256)
const beforeHashes = Object.fromEntries(Object.keys(plan.installedSourceOwners).map(file => [file, hash(readFileSync(file))]))
assert.deepEqual(beforeHashes, plan.installedSourceOwners)
const target = realpathSync(framework.path)
const root = realpathSync('node_modules')
const child = relative(root, target)
assert.ok(child && !isAbsolute(child) && !child.split(/[\\/]/).includes('..'))
const metadata = statSync(target)
assert.ok(metadata.isFile())
const original = readFileSync(target)
assert.equal(hash(original), framework.beforeSha256)
let candidate = original.toString('utf8')
assert.deepEqual(Buffer.from(candidate), original)
for (const [before, after] of framework.exactReplacements) {
  assert.equal(candidate.split(before).length, 2)
  candidate = candidate.replace(before, after)
}
const candidateBytes = Buffer.from(candidate)
assert.equal(hash(candidateBytes), framework.afterSha256)
const receipt = resolve(directory, 'framework-correction-receipt.json')
const temporary = target + '.orca-shared-server-' + process.env.GITHUB_RUN_ID + '-' + process.env.GITHUB_RUN_ATTEMPT
assert.equal(existsSync(receipt), false)
assert.equal(existsSync(temporary), false)
writeFileSync(temporary, candidateBytes, { flag: 'wx', mode: metadata.mode })
renameSync(temporary, target)
const afterHashes = Object.fromEntries(Object.keys(plan.installedSourceOwners).map(file => [file, hash(readFileSync(file))]))
assert.deepEqual(afterHashes, { ...beforeHashes, [framework.path]: framework.afterSha256 })
writeFileSync(receipt, JSON.stringify({ sourceSha: plan.sourceHead, definitionSha: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  path: framework.path, resolvedPath: target, beforeHashes, afterHashes,
  patchSha256: framework.patchSha256, applierSha256: framework.applierSha256,
  exactThreeReplacements: true, atomicReplacementBreaksHardlinks: true,
  disposableCiOnly: true, productionInstallNotModified: true }, null, 2) + '\n', { flag: 'wx' })
