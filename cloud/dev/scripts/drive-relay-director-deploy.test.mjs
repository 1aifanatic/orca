import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  MONITOR_MAX_AGE_AT_ENABLE_MS,
  createDriver,
  parseDriverArguments
} from './drive-relay-director-deploy.mjs'
import {
  IMAGE_REPOSITORY,
  REPOSITORY,
  WORKFLOWS,
  blocksDeploy,
  parseConfigureWave,
  rehomeControlFromLog,
  validateDispatchInputs
} from './relay-director-deploy-plan.mjs'
import { RELAY_WORKFLOW_FILE_PREFIX, relayWorkflowPath } from './relay-repository.mjs'

const COMMIT = 'a'.repeat(40)
const OLD = `sha256:${'1'.repeat(64)}`
const NEW = `sha256:${'2'.repeat(64)}`
const CELL = `sha256:${'3'.repeat(64)}`
const START = Date.parse('2026-10-05T04:50:00Z')
const MEMBERSHIP = {
  existingOnly: ['production-gce-c1'],
  migrationOnly: ['production-gce-c34'],
  general: ['production-gce-c27', 'production-gce-c7']
}
const CONTROL = {
  generation: 39,
  enabled: true,
  observationStartedAt: 1_786_687_676_179,
  notBefore: 1_790_934_023_000,
  ratePerMinute: 10,
  preferenceMaxAgeMs: 86_400_000,
  hostCooldownMs: 604_800_000,
  drainGraceMs: 3_600_000
}

function controlLine(mode, control, selector) {
  const result = {
    event: 'relay_regional_rehome_control',
    mode,
    ...(selector ? { selector } : {}),
    control
  }
  return `operate / control\tUNKNOWN STEP\t2026-10-05T04:51:27Z ${JSON.stringify(result)}`
}

function monitorFiles(run, now, overrides = {}) {
  const incidentId = `relay-${run.id}-dry-run`
  const completedAt = new Date(now).toISOString()
  const state = JSON.stringify({
    schemaVersion: 4,
    incidentId,
    environment: 'production',
    preDrainDryRun: true,
    migrationPolicy: 'strict',
    recoverySourceCellId: null,
    capacityCellId: null,
    durationMinutes: 15,
    intervalMs: 60_000,
    sampleCount: 16,
    frozenAt: null,
    failures: [],
    startedAt: new Date(now - 16 * 60_000).toISOString(),
    windowStartedAt: new Date(now - 15 * 60_000).toISOString(),
    lastSampleAt: completedAt,
    completedAt,
    ...overrides
  })
  const manifest = {
    schemaVersion: 1,
    incidentId,
    runId: String(run.id),
    runAttempt: 1,
    commitSha: run.headSha,
    mode: 'dry-run',
    files: { [`${incidentId}.state.json`]: createHash('sha256').update(state).digest('hex') }
  }
  return { [`${incidentId}.state.json`]: state, 'evidence-manifest.json': JSON.stringify(manifest) }
}

// A model of GitHub Actions and Cloud Run: each dispatch does what the real workflow would do to
// `world`, including the side effects a failing run leaves behind.
function fakeWorld(overrides = {}) {
  const world = {
    now: START,
    main: COMMIT,
    nextRunId: 37_000_000_000,
    runs: [],
    active: [],
    printUrl: true,
    revision: 700,
    serving: { revision: 'orca-cloud-relay-00700-qor', digest: OLD },
    rollback: { revision: 'orca-cloud-relay-00699-das', digest: OLD },
    registry: {},
    selector: { generation: 345, attemptId: 'x', membership: MEMBERSHIP },
    control: CONTROL,
    publishedDigest: NEW,
    pushLogDigest: undefined,
    fail: {},
    monitorState: {},
    director5xx: () => 10,
    prompts: [],
    answer: (question) => question.match(/^Type (.+) to continue/)[1],
    printed: [],
    ...overrides
  }
  // The last rehome run before this deploy, where the driver finds the current generation.
  world.runs.push({
    id: 1,
    file: WORKFLOWS.rehome.file,
    conclusion: 'success',
    log: controlLine('enable', world.control)
  })
  world.dispatches = () => world.runs.filter((run) => run.dispatched)
  return world
}

function promote(world, digest) {
  world.revision += 5
  world.rollback = { revision: `orca-cloud-relay-00${world.revision - 1}-rbk`, digest }
  world.serving = { revision: `orca-cloud-relay-00${world.revision}-new`, digest }
}

function simulate(world, run) {
  const { inputs } = run
  const failure = world.fail[run.key]
  delete world.fail[run.key]
  run.conclusion = failure ? 'failure' : 'success'
  if (failure === 'before-apply') return
  if (run.file === WORKFLOWS.admission.file && inputs.mode === 'inspect') {
    const result = {
      v: 1,
      mode: 'inspect',
      generation: world.selector.generation,
      membership: world.selector.membership
    }
    run.artifacts[`relay-asia-admission-result-${run.id}-1`] = {
      'result.json': JSON.stringify(result)
    }
  } else if (run.file === WORKFLOWS.admission.file) {
    assert.equal(inputs.confirmation, 'CONFIGURE_ASIA_DIRECTOR')
    promote(world, inputs['director-image-digest'])
  } else if (run.file === WORKFLOWS.rehome.file) {
    const identities =
      inputs['director-image-digest'] === world.serving.digest &&
      inputs['rollback-image-digest'] === world.rollback.digest
    const matches =
      Number(inputs['expected-control-generation']) === world.control.generation &&
      Number(inputs['expected-selector-generation']) === world.selector.generation
    if (inputs.mode === 'pause' && matches && world.control.enabled) {
      // The real job applies the pause before anything else can fail.
      world.control = { ...world.control, generation: world.control.generation + 1, enabled: false }
      run.log = controlLine('pause', world.control)
      return
    }
    if (inputs.mode === 'enable' && (!matches || !identities || failure)) {
      run.conclusion = 'failure'
      run.log = controlLine('recover-enable', world.control)
      return
    }
    if (!matches || (inputs.mode === 'inspect' && !identities)) {
      run.conclusion = 'failure'
      return
    }
    if (inputs.mode === 'enable') {
      assert.equal(inputs.confirmation, 'ENABLE_REGIONAL_REHOMING')
      assert.equal(
        world.runs.find((other) => other.id === Number(inputs['monitor-run-id']))?.file,
        WORKFLOWS.monitor.file
      )
      world.control = { ...world.control, generation: world.control.generation + 1, enabled: true }
    }
    run.log = controlLine(
      inputs.mode,
      world.control,
      inputs.mode === 'inspect' ? world.selector : undefined
    )
  } else if (run.file === WORKFLOWS.publish.file) {
    world.registry[`${IMAGE_REPOSITORY}:sha-${run.headSha}`] = world.publishedDigest
    run.log = `publish\tBuild\tsha-${run.headSha}: digest: ${world.pushLogDigest ?? world.publishedDigest} size: 3241`
  } else if (run.file === WORKFLOWS.director.file) {
    if (
      world.control.enabled ||
      Number(inputs['expected-rehome-generation']) !== world.control.generation
    ) {
      run.conclusion = 'failure'
      return
    }
    promote(world, inputs['image-digest'])
  } else if (run.file === WORKFLOWS.monitor.file) {
    world.now += 16 * 60_000
    run.artifacts[`relay-monitor-dry-run-${run.id}-1`] = monitorFiles(
      run,
      world.now,
      world.monitorState
    )
  }
}

function flag(args, name) {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

function gh(world, args, input) {
  const ok = (value) => ({
    status: 0,
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: ''
  })
  if (args[0] === 'api' && args[1] === 'user') return ok('operator\n')
  if (args[0] === 'api' && args.includes('--paginate')) {
    const status = args.find((arg) => arg.startsWith('status=')).slice('status='.length)
    return ok(
      world.active
        .filter((run) => run.status === status)
        .map((run) => `${JSON.stringify(run)}\n`)
        .join('')
    )
  }
  if (args[0] === 'api') return ok(`${world.main}\n`)
  if (args[0] === 'workflow') {
    const workflow = Object.values(WORKFLOWS).find((candidate) => candidate.file === args[2])
    const inputs = JSON.parse(input)
    const run = {
      id: world.nextRunId++,
      file: workflow.file,
      name: workflow.name,
      inputs,
      key: `${workflow.file}:${inputs.mode ?? 'deploy'}`,
      dispatched: true,
      createdAt: new Date(world.now).toISOString(),
      headSha: world.main,
      artifacts: {},
      log: ''
    }
    world.runs.push(run)
    simulate(world, run)
    return ok(
      world.printUrl ? `https://github.com/${REPOSITORY}/actions/runs/${run.id}\n` : 'Created\n'
    )
  }
  const run = world.runs.find((candidate) => candidate.id === Number(args[2]))
  if (args[1] === 'list') {
    const runs = world.runs
      .filter((candidate) => candidate.file === flag(args, '--workflow'))
      .reverse()
    return ok(
      runs.map((candidate) => ({ databaseId: candidate.id, createdAt: candidate.createdAt }))
    )
  }
  if (args[1] === 'view' && args.includes('--log')) return ok(run.log)
  if (args[1] === 'view') {
    return ok({
      status: 'completed',
      conclusion: run.conclusion,
      attempt: 1,
      headSha: run.headSha,
      headBranch: 'main',
      event: 'workflow_dispatch',
      workflowName: run.name
    })
  }
  if (args[1] === 'download') {
    const files = run.artifacts[flag(args, '-n')]
    if (!files) return { status: 1, stdout: '', stderr: 'no artifact' }
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(flag(args, '-D'), name), content)
    return ok('')
  }
  throw new Error(`unexpected gh ${args.join(' ')}`)
}

function gcloud(world, args) {
  const ok = (value) => ({
    status: 0,
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: ''
  })
  if (args[1] === 'services') {
    return ok({
      status: {
        traffic: [
          { revisionName: world.serving.revision, percent: 100 },
          { revisionName: world.rollback.revision, percent: 0, tag: 'selector-rollback' }
        ]
      }
    })
  }
  if (args[1] === 'revisions') {
    const revision = [world.serving, world.rollback].find(
      (candidate) => candidate.revision === args[3]
    )
    return ok({ spec: { containers: [{ image: `${IMAGE_REPOSITORY}@${revision.digest}` }] } })
  }
  if (args[0] === 'artifacts') return ok(`${world.registry[args[4]] ?? ''}\n`)
  if (args[0] === 'logging') {
    const [, from, to] = args[2].match(/timestamp>="([^"]+)" AND timestamp<"([^"]+)"/)
    return ok('t\n'.repeat(world.director5xx(Date.parse(from), Date.parse(to))))
  }
  throw new Error(`unexpected gcloud ${args.join(' ')}`)
}

function dependencies(world) {
  return {
    run: (program, args, input) =>
      program === 'gh' ? gh(world, args, input) : gcloud(world, args),
    stream: () => 0,
    now: () => world.now,
    sleep: async (ms) => {
      world.now += ms
    },
    print: (line) => world.printed.push(line),
    prompt: async (question) => {
      world.prompts.push(question.match(/^Type (.+) to continue/)[1])
      return world.answer(question)
    }
  }
}

function start(world, extra = [], deps = dependencies(world)) {
  const argv = [
    '--commit',
    COMMIT,
    '--state-directory',
    mkdtempSync(join(tmpdir(), 'relay-deploy-test-')),
    ...extra
  ]
  return createDriver(parseDriverArguments(argv), deps).run()
}

const resume = (world, statePath, deps = dependencies(world)) =>
  createDriver(parseDriverArguments(['--resume', statePath]), deps).run()

const stopped = (promise) =>
  promise.then(
    () => assert.fail('expected the driver to stop'),
    (error) => error
  )

function keys(world) {
  return world
    .dispatches()
    .map((run) => run.key.slice(RELAY_WORKFLOW_FILE_PREFIX.length).replace('.yml', ''))
}

const dispatched = (world, key) => world.dispatches().filter((run) => run.key === key)
const REHOME = (mode) => `${WORKFLOWS.rehome.file}:${mode}`
const DEPLOY = `${WORKFLOWS.director.file}:deploy`
const MONITOR = `${WORKFLOWS.monitor.file}:dry-run`
const report = (world) => world.printed.join('\n')

test('runs the audited sequence with typed phrases and enables on the digests now serving', async () => {
  const world = fakeWorld()
  const result = await start(world)
  assert.equal(result.done, true)
  assert.deepEqual(keys(world), [
    'operate-relay-asia-admission:inspect',
    'operate-relay-production-rehome:inspect',
    'operate-relay-production-rehome:pause',
    'publish-relay-production:publish',
    'deploy-relay-production-director:deploy',
    'operate-relay-production-rehome:inspect',
    'monitor-relay-production:dry-run',
    'operate-relay-production-rehome:enable'
  ])
  assert.deepEqual(world.prompts, [
    'DEPLOY aaaaaaaaaaaa',
    'PAUSE_REGIONAL_REHOMING',
    'ENABLE_REGIONAL_REHOMING'
  ])
  const [deploy] = dispatched(world, DEPLOY)
  assert.deepEqual(
    [
      deploy.inputs['image-digest'],
      deploy.inputs['predecessor-image-digest'],
      deploy.inputs['expected-rehome-generation']
    ],
    [NEW, OLD, '40']
  )
  const [pause] = dispatched(world, REHOME('pause'))
  assert.deepEqual(
    [pause.inputs['expected-control-generation'], pause.inputs.confirmation],
    ['39', 'PAUSE_REGIONAL_REHOMING']
  )
  const [enable] = dispatched(world, REHOME('enable'))
  const [monitor] = dispatched(world, MONITOR)
  assert.deepEqual(
    [
      enable.inputs['director-image-digest'],
      enable.inputs['rollback-image-digest'],
      enable.inputs['expected-control-generation'],
      enable.inputs['monitor-run-id']
    ],
    [NEW, NEW, '40', String(monitor.id)]
  )
  assert.equal(monitor.inputs['expected-general-cells'], 'production-gce-c27,production-gce-c7')
  assert.deepEqual([world.control.generation, world.control.enabled], [41, true])
  assert.match(readFileSync(join(dirname(result.statePath), 'driver.log'), 'utf8'), /DONE: serving/)
})

test('a wrong phrase stops before the first mutation', async () => {
  const world = fakeWorld({ answer: () => 'yes' })
  assert.match((await stopped(start(world))).message, /expected DEPLOY aaaaaaaaaaaa/)
  assert.deepEqual(keys(world), [
    'operate-relay-asia-admission:inspect',
    'operate-relay-production-rehome:inspect'
  ])
})

test('rehome found disabled is neither paused nor enabled', async () => {
  const world = fakeWorld({ control: { ...CONTROL, generation: 52, enabled: false } })
  await start(world)
  assert.equal(
    dispatched(world, REHOME('pause')).length + dispatched(world, REHOME('enable')).length,
    0
  )
  assert.equal(dispatched(world, DEPLOY)[0].inputs['expected-rehome-generation'], '52')
  assert.match(report(world), /WARNING rehome was disabled when this deploy started/)
})

test('dry run dispatches nothing, prints every step, and leaves nothing to resume', async () => {
  const world = fakeWorld()
  await start(world, ['--dry-run', '--configure', `production-gce-c34=${CELL}`])
  assert.equal(world.dispatches().length, 0)
  assert.equal(world.prompts.length, 0)
  const plan = world.printed.filter((line) => line.includes(' plan '))
  assert.equal(plan.length, 10)
  assert.ok(plan.some((line) => line.includes('"expected-control-generation":"39"')))
  assert.ok(
    plan.some((line) => line.includes('"confirmation":"<operator types CONFIGURE_ASIA_DIRECTOR>"'))
  )
  assert.ok(plan.some((line) => line.includes('plan soak: wait 5 min')))
  const logLine = world.printed[0].match(/ dry run: commit/)
  assert.ok(logLine)
  const directory = mkdtempSync(join(tmpdir(), 'relay-deploy-test-'))
  await start(world, ['--dry-run', '--state-directory', directory])
  const [run] = (await import('node:fs')).readdirSync(directory)
  assert.equal(existsSync(join(directory, run, 'state.json')), false)
  await assert.rejects(resume(world, join(directory, run, 'state.json')), /ENOENT/)
})

test('an in-flight relay workflow on any page stops the preflight', async () => {
  const world = fakeWorld({
    active: [
      {
        id: 9,
        path: relayWorkflowPath('deploy-relay-production-same-cap.yml'),
        name: 'Same cap',
        status: 'waiting'
      }
    ]
  })
  assert.match((await stopped(start(world))).message, /in flight/)
  assert.equal(world.dispatches().length, 0)
})

test('a main that moved past the reviewed commit stops the preflight', async () => {
  const world = fakeWorld({ main: 'b'.repeat(40) })
  assert.match((await stopped(start(world))).message, /not the reviewed/)
})

test('without a printed run URL the driver stops; resume adopts the one stable new run', async () => {
  const world = fakeWorld({ printUrl: false })
  const error = await stopped(start(world))
  assert.match(error.message, /printed no run URL/)
  world.printUrl = true
  assert.equal((await resume(world, error.statePath)).done, true)
  assert.equal(dispatched(world, `${WORKFLOWS.admission.file}:inspect`).length, 2)
})

test('an interrupted dispatch that created no run is dispatched again, not confused with an earlier run', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const run = deps.run
  let refused = false
  deps.run = (program, args, input) => {
    if (!refused && args[0] === 'workflow' && JSON.parse(input).mode === 'pause') {
      refused = true
      return { status: 1, stdout: '', stderr: 'HTTP 502' }
    }
    return run(program, args, input)
  }
  const error = await stopped(start(world, [], deps))
  assert.equal(JSON.parse(readFileSync(error.statePath, 'utf8')).steps.pause.status, 'dispatching')
  await resume(world, error.statePath, deps)
  assert.equal(dispatched(world, REHOME('pause')).length, 1)
  assert.equal(world.control.enabled, true)
})

test('a publish whose log disagrees with the registry stops before deploy', async () => {
  const world = fakeWorld({ pushLogDigest: CELL })
  assert.match((await stopped(start(world))).message, /tag moved/)
  assert.equal(dispatched(world, DEPLOY).length, 0)
})

test('a pause that applied and then failed is reported as PAUSED, and resume finishes', async () => {
  const world = fakeWorld({ fail: { [REHOME('pause')]: 'after-apply' } })
  const error = await stopped(start(world))
  assert.match(report(world), /REHOME IS PAUSED by this driver at generation 40/)
  assert.match(report(world), /--resume /)
  await resume(world, error.statePath)
  assert.equal(dispatched(world, REHOME('pause')).length, 1)
  assert.deepEqual([world.control.generation, world.control.enabled], [41, true])
})

test('a pause run that reports nothing is UNCONFIRMED, and a pause it did not make is never lifted', async () => {
  const world = fakeWorld({ fail: { [REHOME('pause')]: 'before-apply' } })
  const error = await stopped(start(world))
  assert.match(report(world), /REHOME STATE UNCONFIRMED.*MAY BE PAUSED/)
  // A director safety pause lands while the operator reads the report.
  world.control = { ...world.control, generation: 40, enabled: false }
  assert.match((await stopped(resume(world, error.statePath))).message, /pass --rehome-generation/)
  const adopt = parseDriverArguments(['--resume', error.statePath, '--rehome-generation', '40'])
  const refusal = await stopped(createDriver(adopt, dependencies(world)).run())
  assert.match(refusal.message, /which this driver did not pause/)
  assert.equal(dispatched(world, REHOME('enable')).length, 0)
})

test('a failed deploy reports the pause and resume finishes without pausing or publishing again', async () => {
  const world = fakeWorld({ fail: { [DEPLOY]: 'before-apply' } })
  const error = await stopped(start(world))
  assert.match(report(world), /REHOME IS PAUSED/)
  assert.match(report(world), /rollback point: orca-cloud-relay-00700-qor/)
  assert.match(report(world), /director now: serving orca-cloud-relay-00700-qor/)
  await resume(world, error.statePath)
  assert.equal(dispatched(world, REHOME('pause')).length, 1)
  assert.equal(dispatched(world, `${WORKFLOWS.publish.file}:publish`).length, 1)
  assert.equal(dispatched(world, DEPLOY).length, 2)
  assert.equal(world.control.enabled, true)
})

test('a frozen monitor stops with its recorded failures; resume runs a fresh one', async () => {
  const failures = [
    { source: 'auth', code: 'threshold_equal', signal: 'health', observed: 0, threshold: 1 }
  ]
  const world = fakeWorld({ monitorState: { frozenAt: '2026-10-05T05:30:00Z', failures } })
  const error = await stopped(start(world))
  assert.match(error.message, /incomplete or stale[\s\S]*auth threshold_equal health 0 1/)
  world.monitorState = {}
  await resume(world, error.statePath)
  assert.equal(dispatched(world, MONITOR).length, 2)
  assert.equal(world.control.enabled, true)
})

test('stale monitor evidence is not spent on an enable', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const prompt = deps.prompt
  deps.prompt = async (question) => {
    const answer = await prompt(question)
    // The operator arms the enable, then the monitor result arrives late.
    if (answer === 'ENABLE_REGIONAL_REHOMING') {
      const completed = world.now + 16 * 60_000 - MONITOR_MAX_AGE_AT_ENABLE_MS - 1000
      const at = (offset) => new Date(completed - offset).toISOString()
      world.monitorState = {
        completedAt: at(0),
        lastSampleAt: at(0),
        windowStartedAt: at(15 * 60_000),
        startedAt: at(16 * 60_000)
      }
    }
    return answer
  }
  assert.match((await stopped(start(world, [], deps))).message, /past the 150 s budget/)
  assert.equal(dispatched(world, REHOME('enable')).length, 0)
})

test('the ops-log 05:41Z case: a failed enable recovers closed and resume enables on fresh evidence', async () => {
  const world = fakeWorld({ fail: { [REHOME('enable')]: 'after-apply' } })
  const error = await stopped(start(world))
  assert.match(report(world), /REHOME IS PAUSED by this driver at generation 40/)
  await resume(world, error.statePath)
  assert.equal(dispatched(world, MONITOR).length, 2)
  assert.equal(dispatched(world, REHOME('enable')).length, 2)
  assert.deepEqual([world.control.generation, world.control.enabled], [41, true])
})

test('configure waits out a soak, gates on director 5xx, and takes a typed phrase', async () => {
  const world = fakeWorld()
  await start(world, ['--configure', `production-gce-c34=${CELL}`])
  const [configure] = dispatched(world, `${WORKFLOWS.admission.file}:configure`)
  assert.deepEqual(
    [
      configure.inputs['cell-ids'],
      configure.inputs['image-digest'],
      configure.inputs['director-image-digest'],
      configure.inputs['selector-generation']
    ],
    ['production-gce-c34', CELL, NEW, '345']
  )
  assert.ok(world.prompts.includes('CONFIGURE_ASIA_DIRECTOR'))
  assert.match(report(world), /soak: director 5xx 10 in 5 min after the deploy, 10 before it/)

  const spiking = fakeWorld({ director5xx: (from) => (from >= START ? 200 : 10) })
  assert.match(
    (await stopped(start(spiking, ['--configure', `production-gce-c34=${CELL}`]))).message,
    /5xx rose from 10 to 200/
  )
  assert.equal(dispatched(spiking, `${WORKFLOWS.admission.file}:configure`).length, 0)
})

test('resume adopts a monitor that was in flight when the driver stopped', async () => {
  const world = fakeWorld({ fail: { [MONITOR]: 'before-apply' } })
  const error = await stopped(start(world))
  const state = JSON.parse(readFileSync(error.statePath, 'utf8'))
  const monitorRun = {
    ...dispatched(world, MONITOR)[0],
    id: world.nextRunId++,
    key: 'adopted',
    artifacts: {}
  }
  simulate(world, monitorRun)
  world.runs.push(monitorRun)
  state.steps.monitor = {
    status: 'dispatched',
    workflow: WORKFLOWS.monitor.file,
    runId: monitorRun.id,
    attempt: 1,
    headSha: COMMIT,
    url: 'u'
  }
  writeFileSync(error.statePath, JSON.stringify(state))
  await resume(world, error.statePath)
  assert.equal(dispatched(world, MONITOR).length, 1)
  assert.equal(
    dispatched(world, REHOME('enable'))[0].inputs['monitor-run-id'],
    String(monitorRun.id)
  )
})

test('an interrupt prints the state and the resume command', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const config = parseDriverArguments([
    '--commit',
    COMMIT,
    '--state-directory',
    mkdtempSync(join(tmpdir(), 'relay-deploy-test-'))
  ])
  let driver
  deps.stream = () => {
    if (world.dispatches().at(-1)?.key === MONITOR) driver.interrupt('SIGINT')
    return 0
  }
  driver = createDriver(config, deps)
  await driver.run()
  const text = report(world)
  assert.match(
    text,
    /STOPPED: interrupted by SIGINT[\s\S]*REHOME IS PAUSED by this driver at generation 40[\s\S]*--resume /
  )
})

test('argument parsing and plan helpers fail closed', () => {
  assert.throws(() => parseDriverArguments([]), /missing --commit/)
  assert.throws(() => parseDriverArguments(['--commit', 'abc']), /full commit SHA/)
  assert.throws(
    () => parseDriverArguments(['--resume', 'state.json', '--dry-run']),
    /takes its commit/
  )
  assert.throws(
    () => parseDriverArguments(['--commit', COMMIT, '--configure', 'production-gce-c34']),
    /--configure must be/
  )
  assert.deepEqual(parseConfigureWave(`production-gce-c27,production-gce-c28=${CELL}`).cells, [
    'production-gce-c27',
    'production-gce-c28'
  ])
  assert.throws(
    () => validateDispatchInputs({ confirmation: '<operator types X>' }),
    /not resolved/
  )
  assert.throws(
    () => validateDispatchInputs({ 'image-digest': 'sha256:abc' }),
    /not a sha256 digest/
  )
  assert.throws(
    () => validateDispatchInputs({ 'expected-control-generation': '4x' }),
    /not an integer/
  )
  assert.ok(blocksDeploy(relayWorkflowPath('push-deploy.yml')))
  assert.ok(!blocksDeploy(relayWorkflowPath('monitor-relay-clock-skew.yml')))
  assert.equal(rehomeControlFromLog(controlLine('pause', CONTROL), 'pause').control.generation, 39)
  assert.throws(() => rehomeControlFromLog('nothing', 'pause'), /printed no pause control/)
})
