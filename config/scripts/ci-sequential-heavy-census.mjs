import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [command, state] = process.argv.slice(2)
const root = process.cwd()
const output =
  command === 'compare-control' ? undefined : resolve(process.env.RUNNER_TEMP, 'orca-heavy-census')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const write = (path, value) => {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}
const load = (name) => import(pathToFileURL(join(root, 'config/scripts', name)).href)
const normalize = (value) =>
  JSON.parse(
    JSON.stringify(value, (key, item) => {
      return typeof item === 'string' ? item.replaceAll(root, '$WORKSPACE') : item
    })
  )

function compareStates(records) {
  assert.deepEqual(
    records.map((value) => value.state),
    ['separate-tc', 'shared-root', 'shared-mixed']
  )
  const reference = records[0]
  for (const candidate of records.slice(1)) {
    for (const key of [
      'sourceSha',
      'baseSha',
      'policyHashes',
      'compilerHost',
      'compiler',
      'diagnostics',
      'unit'
    ]) {
      assert.deepEqual(candidate[key], reference[key], `${candidate.state}: ${key} differs`)
    }
  }
  for (const record of records) {
    assert.equal(record.compilerStatus, 0)
    assert.equal(record.trackedDriftStatus, 0)
    assert.equal(record.unit.consumerFallbackControls, 'all-passed')
  }
}

if (command === 'compare-control') {
  const sample = {
    sourceSha: 'a',
    baseSha: 'b',
    policyHashes: { 'package.json': 'c' },
    compilerHost: { version: 'v24.20.0' },
    compiler: [{ files: [{ name: 'src/value.ts', hash: 'd' }] }],
    diagnostics: '',
    unit: { files: ['src/value.test.ts'], consumerFallbackControls: 'all-passed' },
    compilerStatus: 0,
    trackedDriftStatus: 0
  }
  const good = ['separate-tc', 'shared-root', 'shared-mixed'].map((name) => ({
    state: name,
    ...structuredClone(sample)
  }))
  compareStates(good)
  for (const mutate of [
    (record) => {
      record.compiler[0].files.pop()
    },
    (record) => {
      record.compiler[0].files[0].hash = 'changed'
    },
    (record) => {
      record.unit.files.push('src/omitted.test.ts')
    },
    (record) => {
      record.diagnostics = 'TS1234'
    },
    (record) => {
      record.compilerStatus = 1
    },
    (record) => {
      record.trackedDriftStatus = 1
    },
    (record) => {
      record.baseSha = 'advanced'
    },
    (record) => {
      record.compilerHost.version = 'v24.21.0'
    }
  ]) {
    const broken = structuredClone(good)
    mutate(broken[1])
    assert.throws(() => compareStates(broken))
  }
  console.log('Exact parity positive control and eight meaningful fault controls passed.')
} else if (command === 'compare') {
  const records = ['separate-tc', 'shared-root', 'shared-mixed'].map((name) =>
    JSON.parse(readFileSync(join(output, name, 'census.json')))
  )
  compareStates(records)
  write(join(output, 'qualification.json'), {
    qualified: true,
    sourceSha: records[0].sourceSha,
    counts: records.map((record) => ({
      state: record.state,
      compilerProjects: record.compiler.length,
      compilerFiles: record.compiler.map((project) => project.files.length),
      unitFiles: record.unit.files.length
    })),
    timingClaim: false,
    hostedAdmissionComparison: 'not-run',
    fullUnitAndPlatformTests: 'not-run'
  })
  console.log(
    'All three clean states have identical compiler inputs/results and unit plans/consumer coverage.'
  )
} else if (command === 'capture') {
  assert.ok(['separate-tc', 'shared-root', 'shared-mixed'].includes(state))
  const directory = join(output, state)
  const context = JSON.parse(readFileSync(join(output, 'context.json')))
  const { runProcessSync } = await load('script-child-process.mjs')
  const git = (args) => {
    const result = runProcessSync({
      program: 'git',
      args,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      maxOutputBytes: 16 * 1024 * 1024
    })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.outputTruncated, false)
    return result.stdout.trim()
  }
  assert.equal(git(['rev-parse', 'HEAD']), context.qualificationTargetCommit)
  const policyHashes = Object.fromEntries(
    Object.keys(context.paths).map((path) => [
      path,
      existsSync(path) ? hash(readFileSync(path)) : null
    ])
  )
  assert.deepEqual(policyHashes, context.paths)
  const { TYPECHECK_PROJECTS } = await load('run-typecheck-projects-in-parallel.mjs')
  const typescriptVersion = JSON.parse(readFileSync('node_modules/typescript/package.json')).version
  const compiler = TYPECHECK_PROJECTS.map(({ config }) => {
    const inspect = (flag) => {
      const result = runProcessSync({
        program: process.execPath,
        args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', `config/${config}`, flag],
        timeoutMs: 20 * 60 * 1000,
        maxOutputBytes: 16 * 1024 * 1024,
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
      })
      assert.equal(result.code, 0, result.stdout + result.stderr)
      assert.equal(result.timedOut, false)
      assert.equal(result.outputTruncated, false)
      assert.equal(result.stderr.trim(), '')
      return result.stdout
    }
    const effectiveConfig = JSON.parse(inspect('--showConfig'))
    const inputs = inspect('--listFilesOnly').split(/\r?\n/).filter(Boolean)
    assert.ok(inputs.length > 0)
    assert.equal(new Set(inputs).size, inputs.length)
    return normalize({
      config,
      typescriptVersion,
      effectiveConfig,
      files: inputs
        .map((name) => ({ name, hash: hash(readFileSync(name)) }))
        .sort((left, right) => left.name.localeCompare(right.name))
    })
  })
  const { discoverUnitFiles, UNIT_INCLUDE, UNIT_EXCLUDE } = await load('ci-unit-files.mjs')
  const { collectUnitDependencyGraph } = await load('ci-unit-dependency-graph.mjs')
  const { planUnitSelection } = await load('ci-unit-selection.mjs')
  const { prepareUnitPlan } = await load('ci-unit-plan.mjs')
  const { readTimingBaseline } = await load('ci-shard-assignment.mjs')
  const { default: TimingSequencer } = await load('ci-unit-sequencer.mjs')
  const files = discoverUnitFiles()
  const originalPlan = JSON.parse(readFileSync('ci-shards/unit-selection.json'))
  assert.equal(originalPlan.sourceSha, context.qualificationTargetCommit)
  assert.deepEqual(originalPlan.files, files)
  const graph = collectUnitDependencyGraph()
  const graphEvidence = {
    files: [...graph.files].sort(),
    opaque: [...graph.opaque].sort(),
    reverseSha256: hash(
      JSON.stringify(
        [...graph.reverse]
          .map(([file, consumers]) => [file, [...consumers].sort()])
          .sort(([left], [right]) => left.localeCompare(right))
      )
    )
  }
  const baseline = readTimingBaseline('unit')
  const witness = files.find((file) => file.startsWith('src/') && file.endsWith('.test.ts'))
  assert.ok(witness)
  const plans = Object.fromEntries(
    [
      ['full', ['package.json'], false, 'shadow'],
      ['shadow-known', [witness], false, 'shadow'],
      ['draft-selected-known', [witness], true, 'selected'],
      ['ready-selected-policy-full', [witness], false, 'selected'],
      ['empty-fallback', [], true, 'selected'],
      ['unknown-fallback', ['src/missing-census-input.ts'], true, 'selected']
    ].map(([name, changed, draft, mode]) => [
      name,
      planUnitSelection({
        files,
        changed,
        graph,
        timings: baseline.timings,
        event: { pull_request: { draft } },
        mode
      })
    ])
  )
  assert.equal(plans['draft-selected-known'].mode, 'selected')
  assert.ok(plans['draft-selected-known'].executionFiles.length < files.length)
  for (const name of [
    'full',
    'shadow-known',
    'ready-selected-policy-full',
    'empty-fallback',
    'unknown-fallback'
  ]) {
    assert.deepEqual(plans[name].executionFiles, files)
  }
  const specs = files.map((file) => ({ moduleId: join(root, file) }))
  const consume = async (name, plan, expected, count = 5) => {
    const path = join(directory, `consumer-${name}.json`)
    if (typeof plan === 'string') {
      writeFileSync(path, plan)
    } else if (plan !== undefined) {
      write(path, plan)
    }
    process.env.ORCA_UNIT_SELECTION_PLAN = path
    process.env.ORCA_SHARD_SOURCE_SHA = context.qualificationTargetCommit
    const selections = []
    for (let index = 1; index <= count; index += 1) {
      process.env.ORCA_SHARD_MANIFEST = join(directory, `assignment-${name}-${index}.json`)
      const sequencer = new TimingSequencer({ config: { root, shard: { index, count } } })
      selections.push(
        (await sequencer.shard(specs)).map((spec) =>
          relative(root, spec.moduleId).replaceAll('\\', '/')
        )
      )
    }
    const assigned = selections.flat().sort()
    assert.equal(new Set(assigned).size, assigned.length)
    assert.deepEqual(assigned, [...expected].sort(), `${name}: consumer coverage differs`)
    return selections
  }
  const assignments = {}
  for (const [name, plan] of Object.entries(plans)) {
    assignments[name] = await consume(
      name,
      { sourceSha: context.qualificationTargetCommit, ...plan },
      plan.executionFiles,
      plan.shards.length
    )
  }
  const verified = {
    sourceSha: context.qualificationTargetCommit,
    ...plans['draft-selected-known']
  }
  for (const [name, broken] of [
    ['missing', undefined],
    ['invalid-json', '{'],
    ['stale-source', { ...verified, sourceSha: '0'.repeat(40) }],
    ['invalid-version', { ...verified, version: 0 }],
    ['wrong-inventory', { ...verified, files: files.slice(1) }],
    [
      'outside-execution',
      {
        ...verified,
        executionFiles: [...verified.executionFiles, 'src/missing-census-input.test.ts']
      }
    ],
    ['empty-execution', { ...verified, executionFiles: [] }]
  ]) {
    await consume(name, broken, files)
  }
  const preparedPlans = {}
  for (const [name, draft, mode] of [
    ['ready-shadow', false, 'shadow'],
    ['draft-shadow', true, 'shadow'],
    ['draft-selected', true, 'selected']
  ]) {
    const eventPath = join(directory, `${name}-event-fixture.json`)
    write(eventPath, { pull_request: { draft } })
    prepareUnitPlan({
      ...process.env,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      ORCA_UNIT_SELECTION_MODE: mode,
      GITHUB_OUTPUT: '',
      GITHUB_STEP_SUMMARY: ''
    })
    preparedPlans[name] = JSON.parse(readFileSync('ci-shards/unit-selection.json'))
    assert.equal(preparedPlans[name].sourceSha, context.qualificationTargetCommit)
    assert.deepEqual(preparedPlans[name].files, files)
    assignments[`prepared-${name}`] = await consume(
      `prepared-${name}`,
      preparedPlans[name],
      preparedPlans[name].executionFiles,
      preparedPlans[name].shards.length
    )
  }
  const drift = runProcessSync({
    program: 'git',
    args: ['diff', '--exit-code', 'HEAD'],
    maxOutputBytes: 16 * 1024 * 1024
  })
  const record = {
    state,
    sourceSha: context.qualificationTargetCommit,
    baseSha: git(['rev-parse', 'HEAD^1']),
    policyHashes,
    workflowContext: {
      sourceSha: process.env.GITHUB_SHA,
      workflowSha: process.env.GITHUB_WORKFLOW_SHA,
      event: process.env.GITHUB_EVENT_NAME,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT
    },
    compilerHost: {
      version: process.version,
      executable: process.execPath,
      platform: process.platform,
      arch: process.arch
    },
    installHost: JSON.parse(readFileSync(join(directory, 'install-host.json'))),
    typeScriptCacheHit: process.env.TS_CACHE_HIT,
    compiler,
    compilerStatus: Number(readFileSync(join(directory, 'compiler-status.txt'), 'utf8').trim()),
    diagnostics: readFileSync(join(directory, 'diagnostics.log'), 'utf8').replaceAll(
      root,
      '$WORKSPACE'
    ),
    trackedDriftStatus: drift.code,
    unit: {
      files,
      graph: graphEvidence,
      include: UNIT_INCLUDE,
      exclude: UNIT_EXCLUDE,
      originalPlan,
      witness,
      baselineSha256: baseline.baselineSha256,
      plans,
      preparedPlans,
      assignments,
      consumerFallbackControls: 'all-passed'
    }
  }
  write(join(directory, 'census.json'), record)
  assert.equal(record.compilerStatus, 0)
  assert.equal(record.trackedDriftStatus, 0, drift.stdout + drift.stderr)
} else {
  throw new Error('Use capture <state>, compare or compare-control')
}
