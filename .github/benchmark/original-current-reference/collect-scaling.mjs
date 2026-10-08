import assert from 'node:assert/strict'
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { inspect } from 'node:util'
import { sha, validateReferenceSample } from './reference-sample-contract.mjs'

const directory = resolve(import.meta.dirname), root = resolve(process.argv[2]), count = Number(process.argv[3])
assert.ok([10, 20].includes(count))
const plan = JSON.parse(readFileSync(resolve(directory, `reference-plan-${count}.json`), 'utf8')), arm = plan.arms.current
const output = `shard-scaling-${count}-result.json`
assert.equal(existsSync(output), false)
const result = { cacheFootprintObservations: [], qualified: false, performanceAdoptionQualified: false, geometry: count, samples: [], errors: [], definitionSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, firstCommandsRetained: true, independentlyColdOsHosts: false, scope: 'One staged first-command wave; max command is an unsynchronized scheduling proxy. Release/queue/setup/job/collector and ceil-minute ledger are separate. No causal fleet, warm-cache or full PR gain claim.' }
try {
  assert.equal(sha(readFileSync(resolve(directory, '../../..', '.github/workflows/ci-pnpm-verification-pilot.yml'))), plan.definitionWorkflowSha256)
  for (const [file, expected] of Object.entries(plan.payloadSha256)) assert.equal(sha(readFileSync(resolve(directory, file))), expected)
  const manifest = JSON.parse(readFileSync(resolve(directory, arm.manifest), 'utf8')), golden = JSON.parse(readFileSync(resolve(directory, 'golden-case-manifest.json'), 'utf8'))
  assert.equal(sha(readFileSync(resolve(directory, 'golden-case-manifest.json'))), plan.sourceCaseAdmission.goldenSha256)
  const paths = globSync(`scaling-${count}-shard-*/current-shard-*-round-0-summary.json`, { cwd: root }).sort()
  assert.equal(paths.length, count)
  assert.equal(globSync(`scaling-${count}-shard-*/*-round-[12]-summary.json`, { cwd: root }).length, 0, 'No hidden warm commands')
  const seenShards = new Set(), actualFiles = [], checkedGolden = {}, states = {}, signatures = []
  let release, nodeExecutable, callerEnv
  for (const path of paths) {
    const file = resolve(root, path), row = JSON.parse(readFileSync(file, 'utf8')), payload = dirname(file)
    assert.equal(row.arm, 'current'); assert.equal(row.round, 0); assert.equal(row.qualified, true); assert.deepEqual(row.errors, [])
    assert.equal(seenShards.has(row.shard), false); seenShards.add(row.shard)
    assert.equal(path.split('/')[0], `scaling-${count}-shard-${row.shard}`)
    assert.equal(sha(readFileSync(resolve(payload, 'reference-plan.json'))), sha(readFileSync(resolve(directory, `reference-plan-${count}.json`))))
    const context = JSON.parse(readFileSync(resolve(payload, 'materialization-proof.json'), 'utf8'))
    assert.equal(context.geometry, count); assert.equal(context.sourceSha, arm.sourceSha); assert.equal(context.definitionSha, process.env.GITHUB_SHA)
    assert.equal(context.runId, process.env.GITHUB_RUN_ID); assert.equal(context.runAttempt, process.env.GITHUB_RUN_ATTEMPT)
    assert.equal(context.planSha256, row.planSha256); assert.deepEqual(context.sourceSha256, arm.sourceSha256); assert.deepEqual(context.payloadSha256, plan.payloadSha256)
    assert.equal(context.goldenSha256, plan.sourceCaseAdmission.goldenSha256)
    if (release) assert.equal(context.releasedAt, release); else release = context.releasedAt
    assert.ok(Date.parse(row.startedAt) >= Date.parse(release)); assert.ok(Number.isFinite(row.seconds) && row.seconds > 0)
    const checked = validateReferenceSample(row, file.replace(/-summary\.json$/, ''), plan, { payload, definitionSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT })
    const rawReport = JSON.parse(readFileSync(file.replace(/-summary\.json$/, '.json'), 'utf8'))
    const reportModules = new Map(rawReport.testResults.map(module => [module.name.replaceAll('\\', '/').slice(row.sourceRoot.replaceAll('\\', '/').length + 1), module]))
    const byFile = new Map(checked.files.map(file => [file, []]))
    for (const test of checked.canonical) byFile.get(test.file).push([test.assertionIndex, test.fullName, test.title, test.ancestorTitles, test.status])
    for (const [file, tuples] of byFile) {
      assert.equal(Object.hasOwn(checkedGolden, file), false)
      const module = row.details.modules.find(module => module.file === file)
      const tupleJson = JSON.stringify(tuples).replace(/[\u0080-\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
      const actual = { caseMapSha256: sha(tupleJson), route: [module.project, module.pool], moduleStatus: reportModules.get(file).status, caseCount: tuples.length }
      assert.deepEqual(actual, golden.files[file], `Original per-file ordinal/title/ancestor/status/route map changed: ${file}`)
      checkedGolden[file] = actual
    }
    if (nodeExecutable) assert.equal(row.host.nodeExecutable, nodeExecutable); else nodeExecutable = row.host.nodeExecutable
    if (callerEnv) assert.deepEqual(row.callerEnv, callerEnv); else callerEnv = row.callerEnv
    const signature = { ...checked.signature, projects: checked.signature.projects.map(project => ({ ...project, fsModuleCachePath: '<verified-owned-per-shard-cache>' })) }
    signatures.push(signature); assert.deepEqual(signature, signatures[0])
    actualFiles.push(...checked.files)
    for (const [status, n] of Object.entries(checked.rawCaseStates)) states[status] = (states[status] ?? 0) + n
    const footprintPath = file.replace(/-summary\.json$/, '-cache-footprint.json')
    const cacheObservation = { qualified: false, shard: row.shard, missing: !existsSync(footprintPath), receiptSha256: null, errors: [] }
    let footprint
    try {
      const bytes = readFileSync(footprintPath); cacheObservation.receiptSha256 = sha(bytes)
      footprint = JSON.parse(bytes)
      cacheObservation.producerErrors = footprint.errors
      assert.equal(footprint.qualified, true); assert.deepEqual(footprint.errors, [])
      assert.equal(footprint.producer.assignmentSha256, sha(readFileSync(file.replace(/-summary\.json$/, '-assignment.json'))))
      assert.deepEqual(footprint.producer.settings, row.details)
      assert.equal(footprint.producer.summarySha256, sha(readFileSync(file))); assert.equal(footprint.producer.planSha256, row.planSha256)
      assert.equal(footprint.producer.sourceSha, arm.sourceSha); assert.equal(footprint.producer.definitionSha, process.env.GITHUB_SHA)
      assert.equal(footprint.producer.runId, process.env.GITHUB_RUN_ID); assert.equal(footprint.producer.runAttempt, process.env.GITHUB_RUN_ATTEMPT)
      assert.equal(footprint.producer.shard, row.shard); assert.equal(footprint.producer.shardCount, count)
      assert.equal(footprint.producer.cacheRoot, row.cacheDirectory); assert.equal(footprint.producer.scriptSha256, plan.payloadSha256['capture-cache-footprint.mjs'])
      assert.ok(footprint.entryCount > 0 && footprint.entryCount <= 50000); assert.equal(footprint.members.length, footprint.entryCount)
      assert.equal(new Set(footprint.members.map(member => member.name)).size, footprint.entryCount)
      assert.ok(footprint.members.every(member => /^(?:[a-f0-9]{40}|_metadata\.json)$/.test(member.name) && /^[a-f0-9]{64}$/.test(member.sha256) && Number.isSafeInteger(member.logicalBytes) && member.logicalBytes >= 0 && Number.isSafeInteger(member.allocatedBytes) && member.allocatedBytes >= 0 && member.identity.nlink === '1'))
      assert.equal(footprint.logicalBytes, footprint.members.reduce((sum, member) => sum + member.logicalBytes, 0)); assert.ok(footprint.logicalBytes <= 536870912)
      assert.equal(footprint.allocatedBytes, footprint.members.reduce((sum, member) => sum + member.allocatedBytes, 0))
      assert.equal(footprint.metadataSha256, footprint.members.find(member => member.name === '_metadata.json')?.sha256 ?? null)
      assert.ok(Number.isFinite(footprint.observationSeconds) && footprint.observationSeconds > 0 && footprint.observationSeconds <= 180)
      cacheObservation.qualified = true
      cacheObservation.logicalBytes = footprint.logicalBytes; cacheObservation.allocatedBytes = footprint.allocatedBytes; cacheObservation.observationSeconds = footprint.observationSeconds
    } catch (error) { cacheObservation.errors.push(inspect(error)) }
    result.cacheFootprintObservations.push(cacheObservation)
    result.samples.push({ shard: row.shard, cacheFootprintSha256: cacheObservation.receiptSha256, cacheFootprintQualified: cacheObservation.qualified, cacheLogicalBytes: cacheObservation.qualified ? footprint.logicalBytes : null, cacheAllocatedBytes: cacheObservation.qualified ? footprint.allocatedBytes : null, cacheHashObservationSeconds: cacheObservation.qualified ? footprint.observationSeconds : null, seconds: row.seconds, startedAt: row.startedAt, finishedAt: row.finishedAt, host: row.host, cacheDirectory: row.cacheDirectory, cacheExistedBefore: row.cacheExistedBefore, cacheEvidence: row.cacheEvidence, resourcePeakBytes: checked.resourcePeakBytes, summarySha256: sha(readFileSync(file)), rawReportSha256: checked.rawReportSha256, detailsSha256: checked.detailsSha256, timingSha256: checked.timingSha256, resourcesSha256: row.resourceSha256, resourcePreflightSha256: row.resourcePreflightSha256, rawLogSha256: row.rawLogSha256, canonicalCaseCount: checked.canonical.length })
  }
  assert.deepEqual([...seenShards].sort((a,b) => a-b), Array.from({ length: count }, (_,i) => i+1))
  assert.deepEqual(actualFiles.sort(), manifest.files); assert.equal(new Set(actualFiles).size, 11715)
  assert.deepEqual(checkedGolden, golden.files); assert.deepEqual(states, golden.rawCaseStates)
  result.rawCases = Object.values(states).reduce((a,b) => a+b, 0); assert.equal(result.rawCases, 114039)
  result.physicalFiles = actualFiles.length; result.rawCaseStates = states; result.signature = signatures[0]
  result.releasedAt = release; result.validatedAt = new Date().toISOString()
  result.unsynchronizedMaximumWholeCommandSeconds = Math.max(...result.samples.map(row => row.seconds))
  result.sumWholeCommandSeconds = result.samples.reduce((sum, row) => sum + row.seconds, 0)
  result.nominalCores = count * 4
  result.releaseToLastCommandCloseSeconds = (Math.max(...result.samples.map(row => Date.parse(row.finishedAt))) - Date.parse(release)) / 1000
  result.releaseToValidationObservationSeconds = (Date.parse(result.validatedAt) - Date.parse(release)) / 1000
  result.firstCommandStartSpreadSeconds = (Math.max(...result.samples.map(row => Date.parse(row.startedAt))) - Math.min(...result.samples.map(row => Date.parse(row.startedAt)))) / 1000
  result.goldenSha256 = plan.sourceCaseAdmission.goldenSha256
  result.cacheFootprintsQualified = result.cacheFootprintObservations.every(row => row.qualified)
  result.cacheFootprintScope = 'Independent noncritical observation. Missing/rejected/cap/layout/hash failure preserves raw receipt and errors, never discards raw command duration or weakens suite/case/source/config/census gates.'
  result.qualified = true
} catch (error) { result.errors.push(inspect(error)); process.exitCode = 1 }
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ qualified: result.qualified, geometry: count, samples: result.samples.length, errors: result.errors, maximumWholeCommandSeconds: result.unsynchronizedMaximumWholeCommandSeconds }))
