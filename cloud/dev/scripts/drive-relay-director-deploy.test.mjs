import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  MONITOR_MAX_AGE_AT_ENABLE_MS,
  createDriver,
  parseDriverArguments
} from './drive-relay-director-deploy.mjs'
import { RELAY_WORKFLOW_FILE_PREFIX, relayWorkflowPath } from './relay-repository.mjs'
import {
  IMAGE_REPOSITORY,
  REPOSITORY,
  WORKFLOWS,
  blocksDeploy,
  monitorVerdict,
  parseConfigureWave,
  rehomeControlFromLog,
  validateDispatchInputs
} from './relay-director-deploy-plan.mjs'

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

function controlLine(mode, control, selector) {
  return `operate / control\tUNKNOWN STEP\t2026-10-05T04:51:27Z ${JSON.stringify({
    event: 'relay_regional_rehome_control',
    mode,
    ...(selector ? { selector } : {}),
    control
  })}`
}

// A small model of GitHub Actions and Cloud Run: each dispatch applies what the real workflow
// would do to `world`, or fails the way the real workflow's guards would.
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
    control: {
      generation: 39,
      enabled: true,
      observationStartedAt: 1_786_687_676_179,
      notBefore: 1_790_934_023_000,
      ratePerMinute: 10,
      preferenceMaxAgeMs: 86_400_000,
      hostCooldownMs: 604_800_000,
      drainGraceMs: 3_600_000
    },
    publishedDigest: NEW,
    pushLogDigest: undefined,
    fail: {},
    monitorState: undefined,
    prompts: [],
    answer: `DEPLOY ${COMMIT.slice(0, 12)}`,
    printed: [],
    ...overrides
  }
  // The last rehome run before this deploy, where the driver finds the current generation.
  world.runs.push({
    id: 1,
    file: WORKFLOWS.rehome.file,
    name: WORKFLOWS.rehome.name,
    createdAt: '2026-10-02T09:37:00Z',
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
  const failWith = world.fail[run.key]
  if (failWith) {
    world.fail[run.key] = typeof failWith === 'number' && failWith > 1 ? failWith - 1 : undefined
    run.conclusion = 'failure'
    return
  }
  run.conclusion = 'success'
  if (run.file === WORKFLOWS.admission.file && inputs.mode === 'inspect') {
    run.artifacts[`relay-asia-admission-result-${run.id}-1`] = {
      'result.json': {
        v: 1,
        mode: 'inspect',
        generation: world.selector.generation,
        membership: world.selector.membership
      }
    }
  } else if (run.file === WORKFLOWS.admission.file && inputs.mode === 'configure') {
    assert.equal(Number(inputs['selector-generation']), world.selector.generation)
    promote(world, inputs['director-image-digest'])
  } else if (run.file === WORKFLOWS.rehome.file) {
    const identities =
      inputs['director-image-digest'] === world.serving.digest &&
      inputs['rollback-image-digest'] === world.rollback.digest
    if (
      Number(inputs['expected-control-generation']) !== world.control.generation ||
      Number(inputs['expected-selector-generation']) !== world.selector.generation ||
      (['inspect', 'enable'].includes(inputs.mode) && !identities)
    ) {
      run.conclusion = 'failure'
      return
    }
    if (inputs.mode === 'pause')
      world.control = { ...world.control, generation: world.control.generation + 1, enabled: false }
    if (inputs.mode === 'enable') {
      const monitor = world.runs.find(
        (candidate) => candidate.id === Number(inputs['monitor-run-id'])
      )
      assert.equal(monitor?.file, WORKFLOWS.monitor.file)
      assert.equal(inputs['rate-per-minute'], '10')
      world.control = {
        ...world.control,
        generation: world.control.generation + 1,
        enabled: true,
        notBefore: Number(inputs['not-before'])
      }
    }
    run.log = [
      'operate / control\tSet up job\tstarting',
      controlLine(
        inputs.mode,
        world.control,
        inputs.mode === 'inspect' ? world.selector : undefined
      )
    ].join('\n')
  } else if (run.file === WORKFLOWS.publish.file) {
    world.registry[`${IMAGE_REPOSITORY}:sha-${run.headSha}`] = world.publishedDigest
    run.log = `publish\tBuild and publish immutable image\tsha-${run.headSha}: digest: ${world.pushLogDigest ?? world.publishedDigest} size: 3241`
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
    run.artifacts[`relay-monitor-dry-run-${run.id}-1`] = {
      [`relay-${run.id}-dry-run.state.json`]: world.monitorState?.(run) ?? {
        schemaVersion: 4,
        incidentId: `relay-${run.id}-dry-run`,
        preDrainDryRun: true,
        migrationPolicy: 'strict',
        frozenAt: null,
        failures: [],
        sampleCount: 16,
        completedAt: new Date(world.now).toISOString()
      }
    }
  }
}

function flag(args, name) {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

function gh(world, args, input) {
  const ok = (stdout) => ({
    status: 0,
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
    stderr: ''
  })
  if (args[0] === 'api' && args[1] === 'user') return ok('operator\n')
  if (args[0] === 'api' && args.includes('-X')) {
    const status = args.find((arg) => arg.startsWith('status=')).slice('status='.length)
    return ok({ workflow_runs: world.active.filter((run) => run.status === status) })
  }
  if (args[0] === 'api' && args[1].endsWith('/commits/main')) return ok(`${world.main}\n`)
  if (args[0] === 'workflow' && args[1] === 'run') {
    const file = args[2]
    const workflow = Object.values(WORKFLOWS).find((candidate) => candidate.file === file)
    const inputs = JSON.parse(input)
    const run = {
      id: world.nextRunId++,
      file,
      name: workflow.name,
      inputs,
      key: `${file}:${inputs.mode ?? 'deploy'}`,
      dispatched: true,
      createdAt: new Date(world.now).toISOString(),
      headSha: world.main,
      artifacts: {},
      log: 'nothing printed'
    }
    world.runs.push(run)
    simulate(world, run)
    return ok(
      world.printUrl
        ? `https://github.com/${REPOSITORY}/actions/runs/${run.id}\n`
        : 'Created workflow_dispatch event\n'
    )
  }
  if (args[0] === 'run' && args[1] === 'list') {
    const file = flag(args, '--workflow')
    return ok(
      world.runs
        .filter((run) => run.file === file)
        .reverse()
        .map((run) => ({ databaseId: run.id, createdAt: run.createdAt }))
    )
  }
  if (args[0] === 'run' && args[1] === 'view') {
    const run = world.runs.find((candidate) => candidate.id === Number(args[2]))
    if (args.includes('--log')) return ok(run.log)
    return ok({
      databaseId: run.id,
      status: run.status ?? 'completed',
      conclusion: run.conclusion,
      attempt: 1,
      headSha: run.headSha,
      headBranch: 'main',
      event: 'workflow_dispatch',
      workflowName: run.name,
      url: `https://github.com/${REPOSITORY}/actions/runs/${run.id}`
    })
  }
  if (args[0] === 'run' && args[1] === 'download') {
    const run = world.runs.find((candidate) => candidate.id === Number(args[2]))
    const files = run.artifacts[flag(args, '-n')]
    if (!files) return { status: 1, stdout: '', stderr: 'no artifact' }
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(flag(args, '-D'), { recursive: true })
      writeFileSync(join(flag(args, '-D'), name), JSON.stringify(content))
    }
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
  if (args[0] === 'run' && args[1] === 'services') {
    return ok({
      status: {
        traffic: [
          { revisionName: world.serving.revision, percent: 100 },
          { revisionName: world.rollback.revision, percent: 0, tag: 'selector-rollback' }
        ]
      }
    })
  }
  if (args[0] === 'run' && args[1] === 'revisions') {
    const revision = [world.serving, world.rollback].find(
      (candidate) => candidate.revision === args[3]
    )
    return ok({ spec: { containers: [{ image: `${IMAGE_REPOSITORY}@${revision.digest}` }] } })
  }
  if (args[0] === 'artifacts') return ok(`${world.registry[args[4]] ?? ''}\n`)
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
      world.prompts.push(question)
      return world.answer
    }
  }
}

function stateDirectory() {
  return mkdtempSync(join(tmpdir(), 'relay-director-deploy-test-'))
}

async function drive(world, argv) {
  return await createDriver(parseDriverArguments(argv), dependencies(world)).run()
}

function dispatchedKeys(world) {
  return world
    .dispatches()
    .map((run) => run.key.slice(RELAY_WORKFLOW_FILE_PREFIX.length).replace('.yml', ''))
}

function dispatched(world, key) {
  return world.dispatches().filter((run) => run.key === key)
}

test('runs the audited sequence and enables with the digests serving after the deploy', async () => {
  const world = fakeWorld()
  const result = await drive(world, ['--commit', COMMIT, '--state-directory', stateDirectory()])
  assert.equal(result.done, true)
  assert.deepEqual(dispatchedKeys(world), [
    'operate-relay-asia-admission:inspect',
    'operate-relay-production-rehome:inspect',
    'operate-relay-production-rehome:pause',
    'publish-relay-production:publish',
    'deploy-relay-production-director:deploy',
    'operate-relay-production-rehome:inspect',
    'monitor-relay-production:dry-run',
    'operate-relay-production-rehome:enable'
  ])
  const [deploy] = dispatched(world, `${WORKFLOWS.director.file}:deploy`)
  assert.equal(deploy.inputs['image-digest'], NEW)
  assert.equal(deploy.inputs['predecessor-image-digest'], OLD)
  assert.equal(deploy.inputs['expected-rehome-generation'], '40')
  assert.equal(deploy.inputs['prune-incompatible-revisions'], 'false')
  const [pause] = dispatched(world, `${WORKFLOWS.rehome.file}:pause`)
  assert.equal(pause.inputs['expected-control-generation'], '39')
  assert.equal(pause.inputs['not-before'], String(1_790_934_023_000))
  const enable = dispatched(world, `${WORKFLOWS.rehome.file}:enable`)[0]
  const monitor = dispatched(world, `${WORKFLOWS.monitor.file}:dry-run`)[0]
  assert.equal(enable.inputs['director-image-digest'], NEW)
  assert.equal(enable.inputs['rollback-image-digest'], NEW)
  assert.equal(enable.inputs['expected-control-generation'], '40')
  assert.equal(enable.inputs['monitor-run-id'], String(monitor.id))
  assert.equal(enable.inputs['monitor-run-attempt'], '1')
  assert.equal(monitor.inputs['expected-migration-only-cells'], 'production-gce-c34')
  assert.equal(monitor.inputs['expected-general-cells'], 'production-gce-c27,production-gce-c7')
  assert.deepEqual([world.control.generation, world.control.enabled], [41, true])
  assert.equal(world.prompts.length, 1)
  const state = JSON.parse(readFileSync(result.statePath, 'utf8'))
  assert.deepEqual(state.rollbackPoint, { revision: 'orca-cloud-relay-00700-qor', digest: OLD })
  assert.match(
    readFileSync(join(result.statePath, '..', 'driver.log'), 'utf8'),
    /REHOME RE-ENABLED at generation 41/
  )
})

test('a wrong confirmation stops before the first mutation', async () => {
  const world = fakeWorld({ answer: 'yes' })
  await assert.rejects(
    drive(world, ['--commit', COMMIT, '--state-directory', stateDirectory()]),
    /confirmation did not match/
  )
  assert.deepEqual(dispatchedKeys(world), [
    'operate-relay-asia-admission:inspect',
    'operate-relay-production-rehome:inspect'
  ])
  assert.equal(world.control.enabled, true)
})

test('rehome found disabled is neither paused nor enabled', async () => {
  const world = fakeWorld({ control: { ...fakeWorld().control, generation: 52, enabled: false } })
  await drive(world, ['--commit', COMMIT, '--state-directory', stateDirectory()])
  assert.deepEqual(dispatchedKeys(world), [
    'operate-relay-asia-admission:inspect',
    'operate-relay-production-rehome:inspect',
    'publish-relay-production:publish',
    'deploy-relay-production-director:deploy',
    'operate-relay-production-rehome:inspect',
    'monitor-relay-production:dry-run'
  ])
  assert.equal(
    dispatched(world, `${WORKFLOWS.director.file}:deploy`)[0].inputs['expected-rehome-generation'],
    '52'
  )
  assert.deepEqual([world.control.generation, world.control.enabled], [52, false])
})

test('dry run dispatches nothing and prints every planned input', async () => {
  const world = fakeWorld()
  const result = await drive(world, [
    '--commit',
    COMMIT,
    '--dry-run',
    '--state-directory',
    stateDirectory(),
    '--configure',
    `production-gce-c34=${CELL}`
  ])
  assert.equal(result.dryRun, true)
  assert.equal(world.dispatches().length, 0)
  assert.equal(world.prompts.length, 0)
  const plan = world.printed.filter((line) => line.includes(' plan '))
  assert.equal(plan.length, 9)
  assert.ok(plan.some((line) => line.includes('"expected-control-generation":"39"')))
  assert.ok(
    plan.some((line) => line.includes('configure:production-gce-c34') && line.includes(CELL))
  )
  assert.ok(plan.some((line) => line.includes('"image-digest":"<published digest>"')))
  assert.ok(world.printed.some((line) => line.includes('dry run: nothing dispatched')))
})

test('an in-flight relay workflow stops the preflight', async () => {
  const world = fakeWorld({
    active: [
      {
        id: 9,
        path: relayWorkflowPath('deploy-relay-production-same-cap.yml'),
        name: 'Same cap',
        status: 'in_progress'
      }
    ]
  })
  await assert.rejects(
    drive(world, ['--commit', COMMIT, '--state-directory', stateDirectory()]),
    /relay workflows are in flight/
  )
  assert.equal(world.dispatches().length, 0)
})

test('a main that moved past the reviewed commit stops the preflight', async () => {
  const world = fakeWorld({ main: 'b'.repeat(40) })
  await assert.rejects(
    drive(world, ['--commit', COMMIT, '--state-directory', stateDirectory()]),
    /not the reviewed/
  )
  assert.equal(world.dispatches().length, 0)
})

test('finds the dispatched run when gh prints no URL', async () => {
  const world = fakeWorld({ printUrl: false })
  const result = await drive(world, ['--commit', COMMIT, '--state-directory', stateDirectory()])
  assert.equal(result.done, true)
})

test('refuses to guess between two new runs of the same workflow', async () => {
  const world = fakeWorld({ printUrl: false })
  const deps = dependencies(world)
  const run = deps.run
  deps.run = (program, args, input) => {
    const result = run(program, args, input)
    if (program === 'gh' && args[0] === 'workflow') {
      world.runs.push({ ...world.runs.at(-1), id: world.nextRunId++, dispatched: false })
    }
    return result
  }
  await assert.rejects(
    createDriver(
      parseDriverArguments(['--commit', COMMIT, '--state-directory', stateDirectory()]),
      deps
    ).run(),
    /cannot tell which is ours/
  )
})

test('a publish whose log disagrees with the registry digest stops before deploy', async () => {
  const world = fakeWorld({ pushLogDigest: CELL })
  await assert.rejects(
    drive(world, ['--commit', COMMIT, '--state-directory', stateDirectory()]),
    /tag moved/
  )
  assert.equal(dispatched(world, `${WORKFLOWS.director.file}:deploy`).length, 0)
})

test('a failed deploy reports the paused state, and resume finishes without pausing again', async () => {
  const world = fakeWorld()
  world.fail[`${WORKFLOWS.director.file}:deploy`] = 1
  const directory = stateDirectory()
  const error = await drive(world, ['--commit', COMMIT, '--state-directory', directory]).catch(
    (caught) => caught
  )
  assert.match(error.message, /deploy run .* concluded failure/)
  const report = world.printed.join('\n')
  assert.match(report, /rehome: generation 40, PAUSED by this driver/)
  assert.match(report, /rollback point: orca-cloud-relay-00700-qor/)
  assert.match(report, /--resume /)
  const result = await drive(world, ['--resume', error.statePath])
  assert.equal(result.done, true)
  assert.equal(dispatched(world, `${WORKFLOWS.rehome.file}:pause`).length, 1)
  assert.equal(dispatched(world, `${WORKFLOWS.publish.file}:publish`).length, 1)
  assert.equal(dispatched(world, `${WORKFLOWS.director.file}:deploy`).length, 2)
  assert.deepEqual([world.control.generation, world.control.enabled], [41, true])
  assert.equal(world.prompts.length, 2)
})

test('a frozen monitor stops with its recorded failures; resume runs a fresh one', async () => {
  const world = fakeWorld({
    monitorState: (run) => ({
      schemaVersion: 4,
      incidentId: `relay-${run.id}-dry-run`,
      preDrainDryRun: true,
      migrationPolicy: 'strict',
      frozenAt: '2026-10-05T05:30:00Z',
      failures: [
        { source: 'auth', code: 'threshold_equal', signal: 'health', observed: 0, threshold: 1 }
      ],
      sampleCount: 8,
      completedAt: null
    })
  })
  const error = await drive(world, [
    '--commit',
    COMMIT,
    '--state-directory',
    stateDirectory()
  ]).catch((caught) => caught)
  assert.match(error.message, /not green/)
  assert.match(error.message, /auth threshold_equal health 0 1/)
  assert.equal(dispatched(world, `${WORKFLOWS.rehome.file}:enable`).length, 0)
  world.monitorState = undefined
  await drive(world, ['--resume', error.statePath])
  assert.equal(dispatched(world, `${WORKFLOWS.monitor.file}:dry-run`).length, 2)
  assert.equal(world.control.enabled, true)
})

test('stale monitor evidence is not spent on an enable', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const view = deps.run
  deps.run = (program, args, input) => {
    if (program === 'gh' && args[0] === 'run' && args[1] === 'download')
      world.now += MONITOR_MAX_AGE_AT_ENABLE_MS + 1
    return view(program, args, input)
  }
  await assert.rejects(
    createDriver(
      parseDriverArguments(['--commit', COMMIT, '--state-directory', stateDirectory()]),
      deps
    ).run(),
    /monitor evidence is .* old/
  )
  assert.equal(dispatched(world, `${WORKFLOWS.rehome.file}:enable`).length, 0)
})

test('configures named cells on the published director digest before the monitor', async () => {
  const world = fakeWorld()
  await drive(world, [
    '--commit',
    COMMIT,
    '--state-directory',
    stateDirectory(),
    '--configure',
    `production-gce-c34=${CELL}`
  ])
  const [configure] = dispatched(world, `${WORKFLOWS.admission.file}:configure`)
  assert.deepEqual(
    {
      cells: configure.inputs['cell-ids'],
      cell: configure.inputs['image-digest'],
      director: configure.inputs['director-image-digest'],
      selector: configure.inputs['selector-generation'],
      confirmation: configure.inputs.confirmation
    },
    {
      cells: 'production-gce-c34',
      cell: CELL,
      director: NEW,
      selector: '345',
      confirmation: 'CONFIGURE_ASIA_DIRECTOR'
    }
  )
  const keys = dispatchedKeys(world)
  assert.ok(
    keys.indexOf('operate-relay-asia-admission:configure') <
      keys.indexOf('monitor-relay-production:dry-run')
  )
  assert.equal(world.control.enabled, true)
})

test('resume adopts a run that was dispatched before the driver stopped', async () => {
  const world = fakeWorld()
  const directory = stateDirectory()
  world.fail[`${WORKFLOWS.monitor.file}:dry-run`] = 1
  const error = await drive(world, ['--commit', COMMIT, '--state-directory', directory]).catch(
    (caught) => caught
  )
  // Rewind the state to "dispatched, never watched", as if the process died during the watch.
  const state = JSON.parse(readFileSync(error.statePath, 'utf8'))
  delete state.steps.monitor
  state.steps.enable = undefined
  const monitorRun = {
    ...world.runs.find((run) => run.file === WORKFLOWS.monitor.file),
    id: world.nextRunId++
  }
  simulate(world, Object.assign(monitorRun, { key: 'adopted' }))
  world.runs.push(monitorRun)
  state.steps.monitor = {
    status: 'dispatched',
    workflow: WORKFLOWS.monitor.file,
    runId: monitorRun.id,
    attempt: 1,
    url: 'u'
  }
  writeFileSync(error.statePath, JSON.stringify(state))
  await drive(world, ['--resume', error.statePath])
  assert.equal(dispatched(world, `${WORKFLOWS.monitor.file}:dry-run`).length, 1)
  const [enable] = dispatched(world, `${WORKFLOWS.rehome.file}:enable`)
  assert.equal(enable.inputs['monitor-run-id'], String(monitorRun.id))
})

test('a dispatch interrupted before its run existed is dispatched again, not confused with an earlier run', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const run = deps.run
  let refused = false
  deps.run = (program, args, input) => {
    if (
      !refused &&
      program === 'gh' &&
      args[0] === 'workflow' &&
      JSON.parse(input).mode === 'pause'
    ) {
      refused = true
      return { status: 1, stdout: '', stderr: 'HTTP 502' }
    }
    return run(program, args, input)
  }
  const config = parseDriverArguments(['--commit', COMMIT, '--state-directory', stateDirectory()])
  const error = await createDriver(config, deps)
    .run()
    .catch((caught) => caught)
  assert.match(error.message, /HTTP 502/)
  assert.equal(JSON.parse(readFileSync(error.statePath, 'utf8')).steps.pause.status, 'dispatching')
  await createDriver(parseDriverArguments(['--resume', error.statePath]), deps).run()
  assert.equal(dispatched(world, `${WORKFLOWS.rehome.file}:pause`).length, 1)
  assert.deepEqual([world.control.generation, world.control.enabled], [41, true])
})

test('argument parsing', () => {
  assert.throws(() => parseDriverArguments([]), /missing --commit/)
  assert.throws(() => parseDriverArguments(['--commit', 'abc']), /full commit SHA/)
  assert.throws(
    () => parseDriverArguments(['--resume', 'state.json', '--commit', COMMIT]),
    /takes its commit/
  )
  assert.throws(
    () => parseDriverArguments(['--commit', COMMIT, '--configure', 'production-gce-c34']),
    /--configure must be/
  )
  const config = parseDriverArguments(
    ['--commit', COMMIT, '--rehome-generation', '40', '--dry-run'],
    '/home/op'
  )
  assert.deepEqual(
    [config.rehomeGeneration, config.dryRun, config.stateDirectory],
    [40, true, '/home/op/.orca/relay-director-deploy']
  )
  assert.deepEqual(parseConfigureWave(`production-gce-c27,production-gce-c28=${CELL}`).cells, [
    'production-gce-c27',
    'production-gce-c28'
  ])
})

test('plan helpers fail closed', () => {
  assert.throws(
    () => validateDispatchInputs({ 'image-digest': '<published digest>' }),
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
  assert.ok(!blocksDeploy('pr.yml'))
  assert.throws(() => rehomeControlFromLog('no result here', 'pause'), /printed no pause control/)
  assert.equal(
    rehomeControlFromLog(controlLine('pause', fakeWorld().control), 'pause').control.generation,
    39
  )
  const verdict = monitorVerdict(
    {
      schemaVersion: 4,
      incidentId: 'relay-1-dry-run',
      preDrainDryRun: true,
      migrationPolicy: 'strict',
      frozenAt: null,
      failures: [],
      sampleCount: 15,
      completedAt: '2026-10-05T05:00:00Z'
    },
    { runId: 1, nowMs: START }
  )
  assert.deepEqual(verdict.reasons, ['only 15 samples'])
})
