import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

if (process.platform !== 'linux') {
  throw new Error('Coordinator observation pilot requires Linux')
}

const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd())
const sourceDirectory = import.meta.dirname
const output = resolve(process.env.RUNNER_TEMP || sourceDirectory, 'orca-coordinator-observation')
const target = 'src/main/runtime/structured-chat-coordinator-mail.test.ts'
const fixture = 'src/main/runtime/structured-chat-coordinator-observation-clock.test-fixture.ts'
const expectedSource = {
  [target]: 'fd206b5e301209a2ff9b6b7e5cadeb13524e828188cfddfba8a05ff02797db9d',
  [fixture]: '723bf0409d7acf78cde0ac4a67faf7a77a4a6275b68086d13048e23748bbc661'
}
const expectedNames = '2e6e925e4919dcb96d37288cc40bfd56a25febbc745468c91cfde6fdace82305'
const inputPaths = [
  target,
  fixture,
  'src/main/runtime/structured-chat-coordinator-fake-codex-fixture.ts',
  'src/main/runtime/orchestration/mail-pointer-repoint-scheduler.ts',
  'config/vitest.config.ts',
  'pnpm-lock.yaml'
]
const activation =
  "      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })\n      active = true"
const hash = (value) => createHash('sha256').update(value).digest('hex')
async function inputs() {
  return Object.fromEntries(
    await Promise.all(
      inputPaths.map(async (path) => [path, hash(await readFile(resolve(workspace, path)))])
    )
  )
}

await mkdir(output, { recursive: true })
const sourceHashes = await inputs()
for (const [path, expected] of Object.entries(expectedSource)) {
  if (sourceHashes[path] !== expected) {
    throw new Error(`Frozen source changed: ${path}`)
  }
}
if ((await readFile(resolve(workspace, fixture), 'utf8')).split(activation).length !== 2) {
  throw new Error('Expected exactly one clock activation to disable')
}
const configs = {}
for (const arm of ['baseline', 'candidate']) {
  configs[arm] = resolve(output, `${arm}.config.mts`)
  await writeFile(
    configs[arm],
    `
import base from ${JSON.stringify(resolve(workspace, 'config/vitest.config.ts'))}
export default {
  ...base,
  plugins: [...(base.plugins ?? []), ...${
    arm === 'baseline'
      ? `[{name:'coordinator-real-clock-baseline',enforce:'pre',transform(code,id){
    if(id.split('?')[0]!==${JSON.stringify(resolve(workspace, fixture))})return
    const original=${JSON.stringify(activation)}
    if(code.split(original).length!==2)throw new Error('Clock activation source changed')
    return code.replace(original,'      // Keep the original real observation windows.')
  }}]`
      : '[]'
  }],
  test:{...base.test,maxWorkers:1,fileParallelism:false,
    reporters:['default',['json',{outputFile:process.env.ORCA_COORDINATOR_REPORT}]]}
}
`
  )
}
const summary = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  sourceSha: process.env.GITHUB_SHA || null,
  sourceHashes,
  expectedCaseNamesSha256: expectedNames,
  orders: [
    ['baseline', 'candidate'],
    ['candidate', 'baseline']
  ],
  runs: [],
  qualified: false,
  methodology:
    'Four native Vitest invocations, one isolated fork per invocation, identical source and inherited guards; only baseline fake-clock activation is disabled. No timing instrumentation or GUI launch.'
}
if (process.argv.includes('--prepare-only')) {
  await writeFile(
    resolve(output, 'prepared.json'),
    `${JSON.stringify({ output, configs, sourceHashes }, null, 2)}\n`
  )
  console.log(output)
  process.exit(0)
}
try {
  for (const [pair, order] of summary.orders.entries()) {
    for (const arm of order) {
      const prefix = resolve(output, `pair-${pair + 1}-${arm}`)
      const chunks = []
      const start = process.hrtime.bigint()
      const child = spawn(
        process.execPath,
        [
          resolve(workspace, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          configs[arm],
          target
        ],
        {
          cwd: workspace,
          env: {
            ...process.env,
            ORCA_BACKGROUND_LAUNCH: '1',
            ORCA_COORDINATOR_REPORT: `${prefix}.json`,
            FORCE_COLOR: '0'
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      child.stdout.on('data', (chunk) => chunks.push(chunk))
      child.stderr.on('data', (chunk) => chunks.push(chunk))
      const exitCode = await new Promise((resolveExit, reject) => {
        child.once('error', reject)
        child.once('close', resolveExit)
      })
      const wallMs = Number(process.hrtime.bigint() - start) / 1e6
      const log = Buffer.concat(chunks).toString()
      await writeFile(`${prefix}.log`, log)
      if (exitCode !== 0) {
        throw new Error(`${arm} failed with exit ${exitCode}; see ${prefix}.log`)
      }
      const report = JSON.parse(await readFile(`${prefix}.json`, 'utf8'))
      const cases = report.testResults
        .flatMap((file) => file.assertionResults)
        .map((test) => ({ name: test.fullName, status: test.status, durationMs: test.duration }))
      if (
        cases.length !== 23 ||
        cases.some((test) => test.status !== 'passed' || !Number.isFinite(test.durationMs))
      ) {
        throw new Error('Expected every original case to pass')
      }
      if (hash(JSON.stringify(cases.map((test) => test.name).sort())) !== expectedNames) {
        throw new Error('Original test identities changed')
      }
      const durationLine = log.split('\n').find((line) => /Duration\s+[\d.]+s/.test(line))
      const phasesMs = Object.fromEntries(
        [
          ...durationLine.matchAll(/(transform|setup|import|tests|environment)\s+([\d.]+)(ms|s)/g)
        ].map(([, phase, value, unit]) => [phase, Number(value) * (unit === 's' ? 1000 : 1)])
      )
      if (Object.keys(phasesMs).length !== 5) {
        throw new Error('Missing Vitest phase timing')
      }
      if (JSON.stringify(await inputs()) !== JSON.stringify(sourceHashes)) {
        throw new Error('Input source changed between invocations')
      }
      const result = {
        pair: pair + 1,
        arm,
        wallMs,
        bodyMs: cases.reduce((sum, test) => sum + test.durationMs, 0),
        phasesMs,
        cases
      }
      summary.runs.push(result)
      console.log(JSON.stringify({ ...result, cases: cases.length }))
    }
  }
  summary.qualified = true
} catch (error) {
  summary.failure = String(error)
  throw error
} finally {
  await writeFile(resolve(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
}
