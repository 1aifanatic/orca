import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { inspect } from 'node:util'
const directory = resolve(import.meta.dirname), shard = Number(process.argv[2])
const prefix = resolve(directory, `current-shard-${shard}-round-0`), output = prefix + '-cache-footprint.json'
assert.equal(existsSync(output), false)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const start = performance.now(), result = { qualified: false, errors: [], interpretation: 'Producer-owned footprint only. No compiled bytes exported, restored, evaluated, deleted or claimed as cache-exclusive saving. Capture wall/held cost follows counted command.' }
try {
  const plan = JSON.parse(readFileSync(resolve(directory, 'reference-plan.json'), 'utf8')), summaryBytes = readFileSync(prefix + '-summary.json'), summary = JSON.parse(summaryBytes)
  assert.equal(summary.qualified, true); assert.equal(summary.result.code, 0); assert.equal(summary.result.signal, null); assert.deepEqual(summary.errors, []); assert.deepEqual(summary.lingeringCoordinators, [])
  assert.equal(summary.arm, 'current'); assert.equal(summary.round, 0); assert.equal(summary.shard, shard)
  assert.equal(summary.planSha256, sha(readFileSync(resolve(directory, 'reference-plan.json'))))
  const root = resolve(directory, 'cache', `current-shard-${shard}`)
  assert.equal(root, summary.cacheDirectory); assert.equal(realpathSync(root), root)
  assert.equal(lstatSync(root).isSymbolicLink(), false); assert.equal(lstatSync(root).isDirectory(), true)
  const names = readdirSync(root).sort(); assert.ok(names.length > 0 && names.length <= 50000)
  const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), nlink: String(stat.nlink) })
  const initialRoot = identity(lstatSync(root, { bigint: true }))
  let total = 0, allocated = 0
  const members = []
  for (const name of names) {
    assert.match(name, /^(?:[a-f0-9]{40}|_metadata\.json)$/)
    const path = resolve(root, name), before = lstatSync(path, { bigint: true })
    assert.equal(before.isFile(), true); assert.equal(before.isSymbolicLink(), false); assert.equal(before.nlink, 1n)
    total += Number(before.size); allocated += Number(before.blocks) * 512
    assert.ok(total <= 536870912); assert.ok(performance.now() - start <= 180000)
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
    let readBytes = 0
    try { assert.deepEqual(identity(fstatSync(fd, { bigint: true })), identity(before)); for (;;) { const n = readSync(fd, buffer, 0, buffer.length, null); if (!n) break; readBytes += n; assert.ok(readBytes <= Number(before.size)); hash.update(buffer.subarray(0, n)) } } finally { closeSync(fd) }
    assert.equal(readBytes, Number(before.size))
    const after = lstatSync(path, { bigint: true }); assert.deepEqual(identity(after), identity(before))
    members.push({ name, logicalBytes: Number(before.size), allocatedBytes: Number(before.blocks) * 512, sha256: hash.digest('hex'), identity: identity(before) })
  }
  for (const member of members) assert.deepEqual(identity(lstatSync(resolve(root, member.name), { bigint: true })), member.identity)
  assert.deepEqual(readdirSync(root).sort(), names); assert.deepEqual(identity(lstatSync(root, { bigint: true })), initialRoot)
  result.producer = { sourceSha: summary.sourceSha, definitionSha: summary.host.definitionSha, runId: summary.host.runId, runAttempt: summary.host.runAttempt, shard, shardCount: plan.arms.current.shardCount, summarySha256: sha(summaryBytes), planSha256: summary.planSha256, assignmentSha256: sha(readFileSync(prefix + '-assignment.json')), cacheRoot: root, settings: summary.details, scriptSha256: sha(readFileSync(import.meta.filename)) }
  result.entryCount = members.length; result.logicalBytes = total; result.allocatedBytes = allocated; result.members = members
  result.metadataSha256 = members.find(member => member.name === '_metadata.json')?.sha256 ?? null
  result.qualified = true
} catch (error) { result.errors.push(inspect(error)); process.exitCode = 1 }
result.observationSeconds = (performance.now() - start) / 1000
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ qualified: result.qualified, entries: result.entryCount, logicalBytes: result.logicalBytes, observationSeconds: result.observationSeconds, errors: result.errors }))
