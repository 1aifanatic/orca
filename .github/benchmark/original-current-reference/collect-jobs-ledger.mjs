import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import { sha } from './reference-sample-contract.mjs'
const directory = resolve(import.meta.dirname), artifacts = resolve(process.argv[2]), output = 'scaling-queue-cost-ledger.json'
assert.equal(existsSync(output), false)
const result = { qualified: false, performanceAdoptionQualified: false, errors: [], actualBillingDollars: null, billingNote: 'Ceil(job elapsed minutes) estimates observed job-rounded runner minutes, not an invoice; public/private/account pricing and free allowance unknown. The ledger job itself is still active; final whole-workflow elapsed/cost requires terminal API supplement.' }
try {
  const waves = [10, 20].map(count => JSON.parse(readFileSync(resolve(artifacts, `scaling-${count}-evidence`, `shard-scaling-${count}-result.json`), 'utf8')))
  for (const wave of waves) { assert.equal(wave.qualified, true); assert.deepEqual(wave.errors, []); assert.equal(wave.physicalFiles, 11715); assert.equal(wave.rawCases, 114039); assert.deepEqual(wave.rawCaseStates, { passed: 112987, skipped: 1052 }); assert.equal(wave.definitionSha, process.env.GITHUB_SHA); assert.equal(wave.runId, process.env.GITHUB_RUN_ID); assert.equal(wave.runAttempt, process.env.GITHUB_RUN_ATTEMPT) }
  assert.deepEqual(waves[0].signature, waves[1].signature); assert.equal(waves[0].goldenSha256, waves[1].goldenSha256)
  assert.ok(Date.parse(waves[1].releasedAt) >= Date.parse(waves[0].validatedAt))
  assert.equal(process.env.GITHUB_REPOSITORY, 'stablyai/orca'); assert.equal(process.env.GITHUB_API_URL, 'https://api.github.com')
  assert.match(process.env.GITHUB_RUN_ID, /^[1-9][0-9]*$/); assert.match(process.env.GITHUB_RUN_ATTEMPT, /^[1-9][0-9]*$/)
  const jobs = []
  for (let page = 1; page <= 2; page++) {
    const url = `${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100&page=${page}`
    const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(20000) })
    assert.equal(response.ok, true)
    const text = await response.text(); assert.ok(Buffer.byteLength(text) <= 4 * 1024 * 1024)
    const data = JSON.parse(text); assert.ok(Array.isArray(data.jobs)); assert.ok(data.total_count <= 100, 'Bounded30-command workflow expected; never silently omit extra jobs')
    writeFileSync(`scaling-jobs-raw-page-${page}.json`, text, { flag: 'wx' }); jobs.push(...data.jobs)
    if (jobs.length >= data.total_count) break
    assert.ok(page < 2)
  }
  assert.equal(new Set(jobs.map(job => job.id)).size, jobs.length)
  result.rawJobsSha256 = [1, 2].flatMap(page => existsSync(`scaling-jobs-raw-page-${page}.json`) ? [sha(readFileSync(`scaling-jobs-raw-page-${page}.json`))] : [])
  const duration = (started, finished) => { const n = (Date.parse(finished) - Date.parse(started)) / 1000; assert.ok(Number.isFinite(n) && n >= 0); return n }
  result.waves = waves.map(wave => {
    const shardJobs = jobs.filter(job => job.name.startsWith(`scaling ${wave.geometry} shard `))
    assert.equal(shardJobs.length, wave.geometry)
    const validation = jobs.filter(job => job.name === `validate scaling ${wave.geometry}`); assert.equal(validation.length, 1)
    const all = [...shardJobs, validation[0]]
    assert.ok(all.every(job => job.status === 'completed' && job.conclusion === 'success' && job.head_sha === process.env.GITHUB_SHA && job.run_id === Number(process.env.GITHUB_RUN_ID)))
    const shardRows = shardJobs.map(job => {
      const shard = Number(job.name.slice(`scaling ${wave.geometry} shard `.length)); assert.ok(Number.isInteger(shard) && shard >= 1 && shard <= wave.geometry)
      const sample = wave.samples.find(row => row.shard === shard); assert.ok(sample)
      assert.ok(job.labels.includes('ubuntu-24.04-arm'))
      assert.ok(Date.parse(job.started_at) >= Date.parse(wave.releasedAt)); assert.ok(Date.parse(sample.startedAt) >= Date.parse(job.started_at)); assert.ok(Date.parse(job.completed_at) >= Date.parse(sample.finishedAt))
      const steps = job.steps.map(step => ({ name: step.name, number: step.number, conclusion: step.conclusion, seconds: step.conclusion === 'skipped' && step.started_at === null && step.completed_at === null ? null : duration(step.started_at, step.completed_at) }))
      const command = steps.filter(step => step.name === 'Count the first complete command'); assert.equal(command.length, 1); assert.equal(command[0].conclusion, 'success')
      const setupSeconds = steps.filter(step => step.number < command[0].number).reduce((sum, step) => sum + step.seconds, 0)
      return { id: job.id, runnerId: job.runner_id, runnerName: job.runner_name, shard, createdAt: job.created_at, startedAt: job.started_at, completedAt: job.completed_at, releaseToRunnerStartSeconds: duration(wave.releasedAt, job.started_at), createdToStartedQueueProvisionSeconds: duration(job.created_at, job.started_at), heldSeconds: duration(job.started_at, job.completed_at), billedCeilMinutes: Math.ceil(duration(job.started_at, job.completed_at) / 60), setupStepSeconds: setupSeconds, steps, commandSeconds: sample.seconds, cacheHashObservationSeconds: sample.cacheHashObservationSeconds }
    })
    assert.equal(new Set(shardRows.map(row => row.shard)).size, wave.geometry)
    const collector = validation[0]
    return { geometry: wave.geometry, nominalCores: wave.geometry * 4, releasedAt: wave.releasedAt, unsynchronizedMaximumWholeCommandSeconds: wave.unsynchronizedMaximumWholeCommandSeconds, sumWholeCommandSeconds: wave.sumWholeCommandSeconds, releaseToLastShardJobSeconds: duration(wave.releasedAt, new Date(Math.max(...shardJobs.map(job => Date.parse(job.completed_at)))).toISOString()), releaseToAllShardsAndCollectorSeconds: duration(wave.releasedAt, collector.completed_at), jobStartSpreadSeconds: (Math.max(...shardRows.map(row => Date.parse(row.startedAt))) - Math.min(...shardRows.map(row => Date.parse(row.startedAt)))) / 1000, sumArmRunnerHeldSeconds: shardRows.reduce((sum,row) => sum + row.heldSeconds,0), sumArmRoundedRunnerMinutes: shardRows.reduce((sum,row) => sum + row.billedCeilMinutes,0), sumSetupStepSeconds: shardRows.reduce((sum,row) => sum + row.setupStepSeconds,0), validationHeldSeconds: duration(collector.started_at, collector.completed_at), validationRoundedRunnerMinutes: Math.ceil(duration(collector.started_at, collector.completed_at) / 60), shardRows }
  })
  result.totalCountedCommands = 30; result.maximumNominalArmCores = 80
  result.maximumCommandRatio = result.waves[0].unsynchronizedMaximumWholeCommandSeconds / result.waves[1].unsynchronizedMaximumWholeCommandSeconds
  result.releaseThroughCollectorRatio = result.waves[0].releaseToAllShardsAndCollectorSeconds / result.waves[1].releaseToAllShardsAndCollectorSeconds
  result.assessedInterpretation = 'Sequential10 then20 waves on different fresh VMs; global fleet/order/cache contention remain unmeasured. One first-command observation each, no independently cold OS, no repeated or warm adoption proof. Historical forecasts and failed original comparisons never substituted.'
  result.qualified = true
} catch (error) { result.errors.push(inspect(error)); process.exitCode = 1 }
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ qualified: result.qualified, totalCountedCommands: result.totalCountedCommands, errors: result.errors }))
