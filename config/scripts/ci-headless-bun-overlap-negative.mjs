import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import {
  ancestors,
  checkInputs,
  delay,
  evidenceRoot,
  identity,
  live,
  observe,
  partPath,
  processRecord,
  readJson,
  retire,
  scanOwned,
  stamp,
  stopObserver,
  writeJson
} from './ci-headless-bun-overlap-pilot.mjs'
import { ownedIdentityMatches } from './ci-headless-bun-negative-proof.mjs'

const root = resolve(import.meta.dirname, '../..')
const id = 'A1'
const control = process.env.PILOT_BUN_NEGATIVE_CONTROL
const hash = (value) => createHash('sha256').update(value).digest('hex')
const marker = '\nconst ORCA_CI_OWNED_SYNTAX_FAULT = ;\n'
const begin = () => readJson(partPath(id, 'begin'))
const plan = () => readJson(join(evidenceRoot(), 'plan.json'))
const optional = (name) => (existsSync(partPath(id, name)) ? readJson(partPath(id, name)) : null)

function guard() {
  identity()
  assert.equal(process.arch, 'x64')
  assert(['bun-failure', 'node-failure', 'cancel'].includes(control))
}

function ownedDetails(record, phase) {
  try {
    const token = begin().token
    const environment = readFileSync(`/proc/${record.pid}/environ`).toString().split('\0')
    const actualToken = environment
      .find((value) => value.startsWith('ORCA_CI_BUN_CASE='))
      ?.slice('ORCA_CI_BUN_CASE='.length)
    const command = readFileSync(`/proc/${record.pid}/cmdline`)
      .toString()
      .split('\0')
      .filter(Boolean)
    const cwd = realpathSync(`/proc/${record.pid}/cwd`)
    const freshIdentity = processRecord(record.pid)
    if (
      !ownedIdentityMatches(record, freshIdentity, actualToken, token) ||
      !environment.includes(`ORCA_CI_BUN_PHASE=${phase}`)
    ) {
      return null
    }
    const directory = phase === 'bun' ? join(process.env.RUNNER_TEMP, 'bun-orcad-source') : root
    const scripts =
      phase === 'bun'
        ? ['build-orcad-bun.mjs', 'build-orcad.mjs']
        : phase === 'node'
          ? ['build-orcad-prebuilds.mjs', 'build-orcad-node.mjs', 'build-orcad.mjs']
          : ['ci-headless-bun-overlap-negative.mjs']
    if (
      !(phase === 'bun' ? [root, directory].includes(cwd) : cwd === directory) ||
      !command.some((arg) =>
        scripts.some(
          (script) =>
            arg === join(directory, 'config/scripts', script) ||
            (cwd === directory && arg === `config/scripts/${script}`)
        )
      )
    ) {
      return null
    }
    if (phase === 'detached' && !command.includes('sentinel')) {
      return null
    }
    if (phase === 'relay' && !command.includes('await-cancel')) {
      return null
    }
    return { phase, token, identity: record, freshIdentity, command, cwd }
  } catch (error) {
    if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) {
      return null
    }
    throw error
  }
}

function active(phase, records = scanOwned(begin().token, optional('owned-processes') ?? [])) {
  for (const record of records) {
    const proof = ownedDetails(record, phase)
    if (proof) {
      return proof
    }
  }
  return null
}

async function waitActive(phase) {
  const until = performance.now() + 30_000
  while (performance.now() < until) {
    const proof = active(phase)
    if (proof) {
      return proof
    }
    await delay(25)
  }
  throw new Error(`Incomplete control: no live owned actual ${phase} builder`)
}

function entryPath(phase) {
  assert(['bun', 'node'].includes(phase))
  return join(
    phase === 'bun' ? join(process.env.RUNNER_TEMP, 'bun-orcad-source') : root,
    'src/main/orcad/main.ts'
  )
}

async function inject(phase) {
  assert.equal(phase, control === 'bun-failure' ? 'bun' : 'node')
  assert(control !== 'cancel')
  assert(!optional('fault'))
  const opposite = await waitActive(phase === 'bun' ? 'node' : 'bun')
  const path = entryPath(phase)
  const stat = lstatSync(path)
  assert(stat.isFile() && !stat.isSymbolicLink())
  const original = readFileSync(path)
  if (phase === 'node') {
    assert.equal(hash(original), plan().sources['src/main/orcad/main.ts'])
  } else {
    assert.equal(hash(original), '84f08627a4540f69ebfe7af22be86a0f901ce2d3fd137abb0af6d107fd2e6c43')
  }
  const backup = partPath(id, 'fault-original-bytes')
  writeFileSync(backup, original, { flag: 'wx' })
  const faulted = Buffer.concat([original, Buffer.from(marker)])
  const fault = {
    control,
    phase,
    relativePath: 'src/main/orcad/main.ts',
    path,
    backup,
    originalSha: hash(original),
    faultSha: hash(faulted),
    mode: stat.mode & 0o777,
    oppositeBeforeBuild: opposite,
    at: stamp(),
    historicalCheckoutDeliberatelyFaulted: phase === 'bun'
  }
  writeJson(partPath(id, 'fault'), fault)
  writeFileSync(path, faulted)
  assert.equal(hash(readFileSync(path)), fault.faultSha)
}

function recordFailure(phase, status) {
  const fault = optional('fault')
  assert(fault && fault.phase === phase)
  const log = readFileSync(join(evidenceRoot(), id, `${phase}-build.log`), 'utf8')
  const opposite = active(phase === 'bun' ? 'node' : 'bun')
  const failure = {
    phase,
    status: Number(status),
    at: stamp(),
    compilerDiagnostic:
      log.includes('ORCA_CI_OWNED_SYNTAX_FAULT') &&
      log.includes('src/main/orcad/main.ts') &&
      /(?:Unexpected|\[ERROR\])/.test(log),
    faultShaAtFailure: hash(readFileSync(entryPath(phase))),
    opposite: opposite ? { ...opposite, liveAtFrontier: true } : null
  }
  writeJson(partPath(id, 'failure'), failure)
  assert(Number.isSafeInteger(failure.status) && failure.status > 0, 'Actual builder did not fail')
  assert.equal(failure.compilerDiagnostic, true, 'Owned syntax diagnostic missing')
  assert.equal(failure.faultShaAtFailure, fault.faultSha)
  assert(
    opposite,
    'Incomplete control: opposite actual builder already exited at returned-failure frontier'
  )
}

function restoreFault() {
  const fault = optional('fault')
  if (!fault) {
    return null
  }
  assert.equal(fault.path, entryPath(fault.phase))
  assert.equal(fault.backup, partPath(id, 'fault-original-bytes'))
  const original = readFileSync(fault.backup)
  assert.equal(hash(original), fault.originalSha)
  assert.equal(lstatSync(fault.path).mode & 0o777, fault.mode)
  assert.equal(
    hash(readFileSync(fault.path)),
    fault.faultSha,
    'Fault bytes changed outside this control'
  )
  writeFileSync(fault.path, original)
  fault.restoredSha = hash(readFileSync(fault.path))
  assert.equal(fault.restoredSha, fault.originalSha)
  writeJson(partPath(id, 'fault-restored'), fault)
  return fault
}

function cancellationReadiness(records) {
  if (control !== 'cancel' || optional('cancel-ready')) {
    return
  }
  const node = active('node', records)
  const bun = active('bun', records)
  const detached = active('detached', records)
  if (!node || !bun || !detached) {
    return
  }
  if (![node, bun, detached].every((proof) => live(proof.identity))) {
    return
  }
  writeJson(partPath(id, 'cancel-ready'), {
    token: begin().token,
    at: stamp(),
    node: { ...node, liveAtReadiness: true },
    bun: { ...bun, liveAtReadiness: true },
    detached: { ...detached, liveAtReadiness: true }
  })
}

function excludeSignalRelay(records) {
  const relay = readJson(partPath(id, 'signal-relay-ready'))
  const proof = ownedDetails(relay.identity, 'relay')
  assert(proof, 'Cancellation relay identity or token changed before observer retirement')
  writeJson(partPath(id, 'signal-relay-exclusion'), {
    ...proof,
    liveAtExclusion: true,
    at: stamp()
  })
  return records.filter((record) => record.pid !== relay.identity.pid)
}

async function spawnDetached() {
  assert.equal(control, 'cancel')
  assert(!optional('detached-ready'))
  const { spawnProcess } = await import('./script-child-process.mjs')
  const child = spawnProcess({
    program: process.execPath,
    args: [import.meta.filename, 'sentinel'],
    cwd: root,
    env: { ...process.env, ORCA_CI_BUN_CASE: begin().token, ORCA_CI_BUN_PHASE: 'detached' },
    stdio: 'ignore',
    detached: true
  })
  child.unref()
  const until = performance.now() + 5_000
  while (!optional('detached-ready') && performance.now() < until) {
    await delay(25)
  }
  assert(optional('detached-ready'), 'Detached child did not become ready')
}

async function reportCancellationReadiness() {
  if (control !== 'cancel') {
    console.log('Readiness reporter is a successful no-op for this failure control')
    return
  }
  const until = performance.now() + 30_000
  while (performance.now() < until) {
    if (optional('cancel-ready')) {
      const node = active('node')
      const bun = active('bun')
      const detached = active('detached')
      if (node && bun && detached) {
        const reporterReady = {
          token: begin().token,
          at: stamp(),
          node: { ...node, liveAtReadiness: true },
          bun: { ...bun, liveAtReadiness: true },
          detached: { ...detached, liveAtReadiness: true }
        }
        writeJson(partPath(id, 'cancel-reporter-ready'), reporterReady)
        console.log(JSON.stringify({ event: 'cancel-reporter-ready', ...reporterReady }))
        return
      }
    }
    await delay(25)
  }
  throw new Error('Incomplete cancellation: reporter missed simultaneous actual builder readiness')
}

async function sentinel() {
  assert.equal(control, 'cancel')
  assert.equal(process.env.ORCA_CI_BUN_CASE, begin().token)
  const ready = {
    token: begin().token,
    identity: processRecord(process.pid),
    at: stamp(),
    limitMilliseconds: 180_000
  }
  writeJson(partPath(id, 'detached-ready'), ready)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      writeJson(partPath(id, 'detached-termination'), {
        signal,
        identity: ready.identity,
        at: stamp()
      })
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
  await delay(180_000)
  writeJson(partPath(id, 'detached-expired'), { identity: ready.identity, at: stamp() })
}

function freshExits(records) {
  const excluded = ancestors()
  return records
    .filter((record) => !excluded.has(record.pid))
    .map((record) => {
      const current = processRecord(record.pid)
      return { identity: record, current, verdict: live(record) ? 'live' : 'exited' }
    })
}

async function cancelledEvidence() {
  const observer = readJson(partPath(id, 'observer-ready'))
  const until = performance.now() + 15_000
  while (live(observer) && performance.now() < until) {
    await delay(25)
  }
  assert(!live(observer), 'Cancelled observer did not exit within its cleanup bound')
  const observerStopped = optional('observer-stopped')
  const cancelCleanup = optional('cancel-cleanup')
  assert(
    observerStopped?.cancelled === true && cancelCleanup?.verifiedExited === true,
    'Incomplete cancellation: termination/cleanup records missing'
  )
  const records = scanOwned(begin().token, readJson(partPath(id, 'owned-processes')))
  const freshCleanup = await retire(records)
  const exits = freshExits(records)
  assert(
    freshCleanup.cleanBefore && exits.every((record) => record.verdict === 'exited'),
    'Owned processes remained after cancellation cleanup'
  )
  checkInputs(id, 'cancel-after')
  const buildersAtTermination = readJson(partPath(id, 'builders-at-termination'))
  const evidence = {
    control,
    token: begin().token,
    identity: identity(),
    inputsRestored: true,
    forbiddenConsumer: Boolean(optional('forbidden-consumer')),
    qualified: false,
    externalHostedVerdictRequired: true,
    termination: readJson(partPath(id, 'termination-received')),
    readiness: readJson(partPath(id, 'cancel-ready')),
    reporterReadiness: readJson(partPath(id, 'cancel-reporter-ready')),
    signalRelay: readJson(partPath(id, 'signal-relay-ready')),
    signalRelayExclusion: readJson(partPath(id, 'signal-relay-exclusion')),
    buildersAtTermination,
    buildersLiveAtTermination: {
      node: Boolean(buildersAtTermination.node),
      bun: Boolean(buildersAtTermination.bun)
    },
    observerStopped,
    cancelCleanup,
    freshCleanup,
    freshExits: exits,
    at: stamp()
  }
  writeJson(partPath(id, 'cancellation-exit-proof'), evidence)
  return evidence
}

async function awaitCancellation() {
  if (control !== 'cancel') {
    return
  }
  writeJson(partPath(id, 'signal-relay-ready'), {
    token: begin().token,
    identity: processRecord(process.pid),
    at: stamp()
  })
  let received = false
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (received) {
        return
      }
      received = true
      void (async () => {
        writeJson(partPath(id, 'termination-received'), {
          signal,
          token: begin().token,
          at: stamp()
        })
        writeJson(partPath(id, 'builders-at-termination'), {
          node: active('node'),
          bun: active('bun')
        })
        const observer = readJson(partPath(id, 'observer-ready'))
        if (live(observer)) {
          const environment = readFileSync(`/proc/${observer.pid}/environ`).toString().split('\0')
          const token = environment
            .find((value) => value.startsWith('ORCA_CI_BUN_CASE='))
            ?.slice('ORCA_CI_BUN_CASE='.length)
          assert(
            ownedIdentityMatches(observer, processRecord(observer.pid), token, begin().token),
            'Observer identity or token changed before signal routing'
          )
          process.kill(observer.pid, signal)
        } else {
          assert(
            optional('observer-stopped')?.cancelled === true,
            'Observer exited without a cancellation disposition'
          )
        }
        await cancelledEvidence()
        console.log(JSON.stringify({ event: 'cancellation-owned-exits-proven', at: stamp() }))
        process.exit(signal === 'SIGINT' ? 130 : 143)
      })().catch((error) => {
        writeJson(partPath(id, 'cancellation-incomplete'), { error: error.message, at: stamp() })
        console.error(error)
        process.exit(1)
      })
    })
  }
  const until = performance.now() + 30_000
  while (!optional('cancel-reporter-ready') && performance.now() < until) {
    await delay(25)
  }
  assert(
    optional('cancel-reporter-ready'),
    'Incomplete control: actual cancellation reporter did not qualify'
  )
  console.log(
    JSON.stringify({
      event: 'normal-cancellation-relay-waiting',
      controlWaitLimitMilliseconds: 120_000
    })
  )
  await delay(120_000)
  throw new Error('Incomplete cancellation: root did not cancel during the bounded control wait')
}

async function collect() {
  const evidence = {
    control,
    token: begin().token,
    identity: identity(),
    qualified: false,
    externalHostedVerdictRequired: true,
    forbiddenConsumer: Boolean(optional('forbidden-consumer'))
  }
  writeJson(partPath(id, 'negative-evidence'), evidence)
  const errors = []
  try {
    if (control === 'cancel' && optional('observer-stopped')?.cancelled === true) {
      Object.assign(evidence, await cancelledEvidence())
    } else {
      evidence.cleanup = await stopObserver(id)
    }
  } catch (error) {
    errors.push(`observer: ${error.message}`)
    try {
      const records = scanOwned(begin().token, optional('owned-processes') ?? [])
      const observer = optional('observer-ready')
      if (observer) {
        records.push(observer)
      }
      evidence.fallbackCleanup = await retire(records)
    } catch (cleanupError) {
      errors.push(`owned cleanup: ${cleanupError.message}`)
    }
  }
  try {
    evidence.fault = restoreFault()
    checkInputs(id, 'negative-after')
    evidence.inputsRestored = true
  } catch (error) {
    errors.push(`owned restoration: ${error.message}`)
  }
  evidence.failure = optional('failure')
  evidence.parts = { node: optional('node-end'), bun: optional('bun-end') }
  if (optional('observer-failed')) {
    errors.push('Ownership observer failed')
  }
  evidence.errors = errors
  evidence.controlEvidenceComplete =
    control === 'cancel' ? Boolean(evidence.termination) : Boolean(evidence.failure?.opposite)
  writeJson(partPath(id, 'negative-evidence'), evidence)
  console.log(
    JSON.stringify({
      event: 'negative-evidence-collected',
      control,
      controlEvidenceComplete: evidence.controlEvidenceComplete,
      externalHostedVerdictRequired: true
    })
  )
  assert.equal(evidence.forbiddenConsumer, false, 'Success-gated consumer was admitted')
  assert.deepEqual(errors, [], 'Negative control cleanup or input proof failed')
  assert.equal(evidence.controlEvidenceComplete, true, 'Incomplete negative control')
}

export { ownedDetails }

if (resolve(process.argv[1]) === import.meta.filename) {
  guard()
  const [operation, phase, status] = process.argv.slice(2)
  if (operation === 'observe') {
    await observe(
      id,
      cancellationReadiness,
      control === 'cancel' ? excludeSignalRelay : undefined
    ).catch((error) => {
      writeJson(partPath(id, 'observer-failed'), { error: error.message, stack: error.stack })
      throw error
    })
  } else if (operation === 'inject') {
    await inject(phase)
  } else if (operation === 'failure') {
    recordFailure(phase, status)
  } else if (operation === 'spawn-detached') {
    await spawnDetached()
  } else if (operation === 'report-cancel-ready') {
    await reportCancellationReadiness()
  } else if (operation === 'sentinel') {
    await sentinel()
  } else if (operation === 'await-cancel') {
    await awaitCancellation()
  } else if (operation === 'consumer') {
    writeJson(partPath(id, 'forbidden-consumer'), { at: stamp(), consumer: phase })
    throw new Error(`Success-gated ${phase} consumer was admitted after a negative control`)
  } else {
    assert.equal(operation, 'collect')
    await collect()
  }
}
