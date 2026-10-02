import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, dirname, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream/promises'
import { parseArgs, stripVTControlCharacters } from 'node:util'
import { createGzip } from 'node:zlib'
import ts from 'typescript-api'
import { describeProcessFailure, runProcessSync } from './script-child-process.mjs'

const repository = resolve(import.meta.dirname, '../..')
const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    'prepare-only': { type: 'boolean', default: false },
    'controls-only': { type: 'boolean', default: false }
  }
})
assert(values.output, '--output is required')
const output = resolve(values.output)
mkdirSync(output, { recursive: true })
const require = createRequire(import.meta.url)
const formatterPath = join(repository, 'src/main/daemon/serialize-grid-cell-descriptors.ts')
const roundtripPath = join(repository, 'src/main/daemon/serialize-grid-roundtrip.ts')
const frozenPath = join(import.meta.dirname, 'ci-serialize-oracle-pilot-baseline.txt')
const baseline = readFileSync(frozenPath, 'utf8')
const candidate = readFileSync(formatterPath, 'utf8')
const roundtrip = readFileSync(roundtripPath, 'utf8')
const frozenSha256 = 'cd587e95ea8a844786e110486538b04c457dcba897b233bc9ecfe16e0ab5d7ff'
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
assert.equal(sha256(baseline), frozenSha256, 'f69052e baseline formatter changed')
assert.notEqual(sha256(candidate), frozenSha256, 'candidate formatter is unchanged')
for (const key of Object.keys(process.env)) {
  assert(
    !key.startsWith('SERIALIZE_') &&
      !key.startsWith('ORCA_OLD_SERIALIZE') &&
      !key.startsWith('ORCA_NEW_SERIALIZE'),
    `Unexpected serializer environment override: ${key}`
  )
}
const cohort = [
  'src/main/daemon/serialize-grid-transcript-replay.test.ts',
  'src/main/daemon/serialize-grid.differential.fuzz.test.ts',
  'src/main/daemon/serialize-addon-edge-cases.test.ts'
]
const control = 'src/main/daemon/serialize-grid-cell-descriptors.test.ts'
const variants = { baseline, candidate }
const captureFiles = []
const runs = []
const controls = []

function inputCensus() {
  const files = new Set()
  const pending = [
    ...cohort,
    control,
    'config/vitest.config.ts',
    'package.json',
    'pnpm-lock.yaml',
    'config/scripts/vitest-real-agent-home-write-guard.ts',
    'config/scripts/happy-dom-offscreen-canvas.ts',
    'config/scripts/happy-dom-mutation-observer-retention.ts',
    'config/scripts/vitest-host-ports-setup.ts',
    'config/scripts/vitest-caller-identity-env-setup.ts'
  ].map((file) => join(repository, file))
  pending.push(
    frozenPath,
    require.resolve('@xterm/headless'),
    require.resolve('@xterm/addon-serialize'),
    require.resolve('@xterm/addon-unicode11')
  )
  while (pending.length) {
    const file = pending.pop()
    if (!existsSync(file) || files.has(file)) {
      continue
    }
    files.add(file)
    if (!/\.(?:ts|tsx|mjs|js)$/.test(file)) {
      continue
    }
    for (const dependency of ts.preProcessFile(readFileSync(file, 'utf8'), false, true)
      .importedFiles) {
      if (!dependency.fileName.startsWith('.')) {
        continue
      }
      const base = resolve(dirname(file), dependency.fileName)
      const resolved = [
        base,
        ...['.ts', '.tsx', '.mjs', '.js', '.json'].map((extension) => base + extension),
        join(base, 'index.ts')
      ].find((path) => existsSync(path) && statSync(path).isFile())
      if (resolved) {
        pending.push(resolved)
      }
    }
  }
  for (const directory of ['src/main/runtime/__fixtures__', 'src/main/daemon/__fixtures__']) {
    for (const entry of readdirSync(join(repository, directory), {
      recursive: true,
      withFileTypes: true
    })) {
      if (entry.isFile()) {
        files.add(join(entry.parentPath, entry.name))
      }
    }
  }
  return [...files]
    .sort()
    .map((file) => ({ file: relative(repository, file), sha256: sha256(readFileSync(file)) }))
}
const census = inputCensus()
const inputHash = sha256(JSON.stringify(census))
const assertInputs = () =>
  assert.equal(
    sha256(JSON.stringify(inputCensus())),
    inputHash,
    'Reachable source, fixture or dependency inputs changed'
  )
writeFileSync(join(output, 'inputs.json'), JSON.stringify({ inputHash, files: census }, null, 2))

function configFor(label, formatter, capture = false, sourceCrash = false) {
  const report = join(output, `${label}.json`)
  const captured = join(output, `${label}-outputs.jsonl`)
  let source = roundtrip
  if (capture) {
    captureFiles.push(captured)
    writeFileSync(captured, '')
    const helper = [
      'function captureFullPilotRun(testCase: SerializeFuzzCase, result: SerializeCaseRun): SerializeCaseRun {',
      `captureFullPilot(${JSON.stringify(captured)}, JSON.stringify({ test: fullPilotExpect.getState().currentTestName, seed: testCase.seed, category: testCase.category, steps: testCase.steps, result }) + "\\n")`,
      'return result',
      '}'
    ].join('\n')
    source = [
      'import { appendFileSync as captureFullPilot } from "node:fs"',
      'import { expect as fullPilotExpect } from "vitest"',
      source
        .replace(
          'export async function runSerializeFuzzCase(',
          `${helper}\nexport async function runSerializeFuzzCase(`
        )
        .replace(
          'return { checks: results, sourceCrash: null }',
          'return captureFullPilotRun(testCase, { checks: results, sourceCrash: null })'
        )
        .replace(
          'return { checks: results, sourceCrash: String(error) }',
          'return captureFullPilotRun(testCase, { checks: results, sourceCrash: String(error) })'
        )
    ].join('\n')
    assert.equal(
      source.match(/captureFullPilotRun/g)?.length,
      3,
      'Both return paths must be captured'
    )
  }
  if (sourceCrash) {
    assert(source.includes('writeTerminal(source, step.data)'))
    source = source.replace(
      'writeTerminal(source, step.data)',
      'throw new XtermWriteCrash("pilot source-crash sentinel")'
    )
  }
  const entries = [
    `if(normalized === ${JSON.stringify(formatterPath.replaceAll('\\', '/'))}) return ${JSON.stringify(formatter)};`,
    ...(capture
      ? [
          `if(normalized === ${JSON.stringify(roundtripPath.replaceAll('\\', '/'))}) return ${JSON.stringify(source)};`
        ]
      : [])
  ].join('\n')
  const config = [
    `import { mergeConfig } from ${JSON.stringify(require.resolve('vitest/config'))}`,
    `import config from ${JSON.stringify(join(repository, 'config/vitest.config.ts'))}`,
    'export default mergeConfig(config, {plugins:[{name:"fixed-serializer-oracle-arm",enforce:"pre",transform(_code,id){const normalized=id.split("?")[0].replaceAll("\\\\","/");',
    entries,
    `}}],test:${JSON.stringify({ maxWorkers: 1, isolate: true, pool: 'forks', reporters: ['default', 'json'], outputFile: report })}})`
  ].join('\n')
  const path = join(output, `${label}.config.ts`)
  writeFileSync(path, config)
  return { label, path, report, captured, log: join(output, `${label}.log`) }
}

function invoke(config, files, pattern) {
  assertInputs()
  const args = [
    join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
    'run',
    '--config',
    config.path,
    ...files,
    ...(pattern ? ['--testNamePattern', pattern] : [])
  ]
  const started = performance.now()
  const result = runProcessSync({
    program: process.execPath,
    args,
    cwd: repository,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 300_000,
    maxOutputBytes: 2 * 1024 * 1024
  })
  const processMs = performance.now() - started
  writeFileSync(config.log, [result.stdout, result.stderr].join('\n'))
  assertInputs()
  assert(!result.timedOut && !result.outputTruncated, describeProcessFailure(result))
  const report = JSON.parse(readFileSync(config.report, 'utf8'))
  const assertions = report.testResults.flatMap((file) => file.assertionResults)
  const names = assertions
    .map((test) => [test.fullName, test.status])
    .sort((a, b) => a[0].localeCompare(b[0]))
  const stripped = stripVTControlCharacters(result.stdout)
  const duration = stripped.match(/Duration\s+([\d.]+)s/)
  return {
    label: config.label,
    code: result.code,
    processMs,
    vitestMs: duration ? Number(duration[1]) * 1000 : null,
    bodyMs: assertions.reduce((sum, test) => sum + (test.duration ?? 0), 0),
    names,
    failures: assertions.filter((test) => test.status === 'failed').map((test) => test.fullName)
  }
}

async function capturedSummary(path) {
  const fileHash = createHash('sha256')
  const input = createReadStream(path)
  input.on('data', (bytes) => fileHash.update(bytes))
  const records = []
  let checkpoints = 0
  let crashes = 0
  const crashMessages = []
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    const record = JSON.parse(line)
    records.push(sha256(line))
    checkpoints += record.result.checks.length
    if (record.result.sourceCrash !== null) {
      crashes++
      crashMessages.push(record.result.sourceCrash)
    }
  }
  return {
    scenarios: records.length,
    checkpoints,
    crashes,
    crashMessages,
    recordsSha256: sha256(JSON.stringify(records.sort())),
    fileSha256: fileHash.digest('hex'),
    bytes: statSync(path).size
  }
}

function requireSuccess(run, reference) {
  assert.equal(run.code, 0, `${run.label}: failed invocation`)
  assert.equal(run.names.filter(([, status]) => status === 'passed').length, 89)
  assert.equal(run.names.filter(([, status]) => status === 'skipped').length, 2)
  assert.equal(run.names.length, 91)
  if (reference) {
    assert.deepEqual(run.names, reference.names, 'Test names/statuses changed')
  }
}
function median(values) {
  return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
}
function changed(source, before, after) {
  assert(source.includes(before), `Mutation target changed: ${before}`)
  return source.replace(before, after)
}

const prepared = configFor('prepared-candidate', candidate)
if (values['prepare-only']) {
  console.log(JSON.stringify({ inputHash, config: prepared.path, frozenSha256, cohort }))
} else {
  try {
    if (!values['controls-only']) {
      let reference
      for (const arm of ['baseline', 'candidate']) {
        const config = configFor(`parity-${arm}`, variants[arm], true)
        const run = invoke(config, cohort)
        requireSuccess(run, reference)
        reference ??= run
        const captured = await capturedSummary(config.captured)
        assert.equal(captured.scenarios, 1435)
        assert.equal(captured.checkpoints, 7649)
        assert.equal(captured.crashes, 0)
        runs.push({ ...run, phase: 'parity', arm, captured })
      }
      assert.equal(
        runs[0].captured.recordsSha256,
        runs[1].captured.recordsSha256,
        'Complete scenario/checkpoint payloads differ'
      )
      for (let pair = 1; pair <= 3; pair++) {
        for (const arm of pair % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
          const config = configFor(['timed', pair, arm].join('-'), variants[arm])
          const run = invoke(config, cohort)
          requireSuccess(run, reference)
          runs.push({ ...run, phase: 'timed', pair, arm })
          console.log(JSON.stringify({ ...run, names: undefined }))
        }
      }
    }
    const positive = invoke(configFor('control-positive', candidate), [control])
    assert.equal(positive.code, 0)
    assert.equal(positive.names.filter(([, status]) => status === 'passed').length, 7)
    controls.push(positive)
    for (const [name, variant, expectedFailures] of [
      [
        'stale-cell',
        changed(
          candidate,
          'const cell = line.getCell(x, reusableCell)',
          'const cell = reusableCell ?? line.getCell(x)'
        ),
        7
      ],
      ['bold-flag', changed(candidate, 'cell.isBold() !== 0', 'false'), 5],
      ['blank-policy', changed(candidate, "const blank = chars === ' '", 'const blank = true'), 2],
      ['allocation-regression', baseline, 1]
    ]) {
      const run = invoke(configFor(`control-${name}`, variant), [control])
      assert.notEqual(run.code, 0, `Mutation passed: ${name}`)
      assert.equal(run.failures.length, expectedFailures, 'Mutation failed for unexpected reason')
      controls.push(run)
    }
    const crashConfig = configFor('control-source-crash', candidate, true, true)
    const crashRun = invoke(crashConfig, [cohort[0]], 'antigravity-1-2-14-busy-streaming:')
    assert.notEqual(crashRun.code, 0)
    assert.equal(crashRun.failures.length, 1)
    const crashCapture = await capturedSummary(crashConfig.captured)
    assert.equal(crashCapture.scenarios, 1)
    assert.equal(crashCapture.crashes, 1)
    assert.deepEqual(crashCapture.crashMessages, ['Error: pilot source-crash sentinel'])
    controls.push({ ...crashRun, captured: crashCapture })
    const timed = runs.filter((run) => run.phase === 'timed')
    const medians = Object.fromEntries(
      (timed.length ? ['processMs', 'vitestMs', 'bodyMs'] : []).map((metric) => {
        const baselineMs = median(
          timed.filter((run) => run.arm === 'baseline').map((run) => run[metric])
        )
        const candidateMs = median(
          timed.filter((run) => run.arm === 'candidate').map((run) => run[metric])
        )
        return [
          metric,
          { baselineMs, candidateMs, deltaPercent: (candidateMs / baselineMs - 1) * 100 }
        ]
      })
    )
    writeFileSync(
      join(output, 'summary.json'),
      JSON.stringify(
        {
          source: process.env.GITHUB_SHA,
          baseFormatterSource: 'f69052e11336eb8004782af02af0c0135d469e92',
          inputHash,
          frozenSha256,
          candidateSha256: sha256(candidate),
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          imageOS: process.env.ImageOS,
          imageVersion: process.env.ImageVersion,
          cohort,
          scope:
            '91 serializer-oracle tests only; 1 isolated fork; uninstrumented alternating timed pairs; capture/compression excluded from timings.',
          medians,
          runs,
          controls
        },
        null,
        2
      )
    )
    console.log(
      JSON.stringify({
        medians,
        controls: controls.map((run) => ({
          label: run.label,
          code: run.code,
          failures: run.failures
        }))
      })
    )
  } finally {
    writeFileSync(
      join(output, 'partial-results.json'),
      JSON.stringify({ inputHash, runs, controls }, null, 2)
    )
    for (const path of captureFiles) {
      if (!existsSync(path)) {
        continue
      }
      await pipeline(createReadStream(path), createGzip(), createWriteStream(`${path}.gz`))
      rmSync(path)
    }
  }
}
