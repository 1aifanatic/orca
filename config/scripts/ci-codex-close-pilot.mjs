import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

assert.equal(process.platform, 'linux')
assert.equal(process.arch, 'arm64')
assert.equal(process.env.RUNNER_OS, 'Linux')
assert.equal(process.env.RUNNER_ARCH, 'ARM64')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch')
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(process.env.GITHUB_WORKFLOW_SHA, process.env.GITHUB_SHA)
assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/)
assert.match(process.env.GITHUB_RUN_ID ?? '', /^[0-9]+$/)
assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/)
assert.equal(process.version, process.env.PILOT_HOST_NODE_VERSION)
assert.match(process.version, /^v24\./)
assert(process.env.RUNNER_TEMP && process.env.GITHUB_WORKSPACE)
assert(process.env.ImageOS && process.env.ImageVersion)
assert(process.env.PILOT_CPU && process.env.PILOT_KERNEL)

const workspace = resolve(process.env.GITHUB_WORKSPACE)
const output = resolve(
  process.env.RUNNER_TEMP,
  `orca-codex-close-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${process.arch}`
)
const target = 'src/main/codex/codex-app-server-connection.test.ts'
const originalSourceSha = '1757b34ce781e1b80e7dbb1835c51a59e690d3a3c97b2f5a41d60a02985ae6e7'
const candidateSourceSha = '3d7dd897613518abe8d4f0adbf58deacc249c61ed934bbe58344d6f267a2e7d0'
const expectedNamesSha = '41f10c1f5007ab8eb3f361378615b13236c0ab7114c118fc6cbcdb840c6b0c9c'
const replacements = [
  {
    title: 'reports unproven close when forced termination did not produce an exit event',
    candidate:
      "  it('reports unproven close when forced termination did not produce an exit event', async () => {\n    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })\n    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })\n    answerInitialize(child)\n    const connection = await openCodexAppServerConnection(\n      { command: 'codex', args: ['app-server'] },\n      {},\n      spawnImpl\n    )\n\n    const forcedKill = new Promise<void>((resolve) => {\n      child.kill.mockImplementation((signal) => {\n        if (signal === 'SIGKILL') {\n          resolve()\n        }\n      })\n    })\n    const closing = connection.close()\n    await flushStreams()\n    await vi.advanceTimersByTimeAsync(GRACEFUL_EXIT_MS)\n    await forcedKill\n    await vi.advanceTimersByTimeAsync(0)\n    await vi.advanceTimersByTimeAsync(1_000)\n\n    await expect(closing).resolves.toBe(false)\n    expect(vi.getTimerCount()).toBe(0)\n  }, 10_000)\n\n",
    original:
      "  it('reports unproven close when forced termination did not produce an exit event', async () => {\n    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })\n    answerInitialize(child)\n    const connection = await openCodexAppServerConnection(\n      { command: 'codex', args: ['app-server'] },\n      {},\n      spawnImpl\n    )\n\n    await expect(connection.close()).resolves.toBe(false)\n  }, 10_000)\n\n"
  },
  {
    title: 'keeps a graceful close quiet when stdin breaks during the reap',
    candidate:
      "  it('keeps a graceful close quiet when stdin breaks during the reap', async () => {\n    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })\n    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })\n    answerInitialize(child)\n    const exits: string[] = []\n    const connection = await openCodexAppServerConnection(\n      { command: 'codex', args: ['app-server'] },\n      { onExit: (error) => exits.push(error.message) },\n      spawnImpl\n    )\n    child.stdin.on('finish', () => child.stdin.emit('error', new Error('write EPIPE')))\n    const forcedKill = new Promise<void>((resolve) => {\n      child.kill.mockImplementation((signal) => {\n        child.emit('exit', null, 'SIGKILL')\n        if (signal === 'SIGKILL') {\n          resolve()\n        }\n        return true\n      })\n    })\n\n    const inFlight = rejection(connection.request('turn/start'))\n    const closing = connection.close()\n    await flushStreams()\n    await vi.advanceTimersByTimeAsync(GRACEFUL_EXIT_MS)\n    await forcedKill\n    await vi.advanceTimersByTimeAsync(0)\n    await expect(closing).resolves.toBe(true)\n\n    expect((await inFlight).message).toContain('EPIPE')\n    expect(exits).toHaveLength(0)\n    expect(vi.getTimerCount()).toBe(0)\n  })",
    original:
      "  it('keeps a graceful close quiet when stdin breaks during the reap', async () => {\n    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })\n    answerInitialize(child)\n    const exits: string[] = []\n    const connection = await openCodexAppServerConnection(\n      { command: 'codex', args: ['app-server'] },\n      { onExit: (error) => exits.push(error.message) },\n      spawnImpl\n    )\n    child.stdin.on('finish', () => child.stdin.emit('error', new Error('write EPIPE')))\n    child.kill.mockImplementation(() => {\n      child.emit('exit', null, 'SIGKILL')\n      return true\n    })\n\n    const inFlight = rejection(connection.request('turn/start'))\n    await connection.close()\n\n    expect((await inFlight).message).toContain('EPIPE')\n    expect(exits).toHaveLength(0)\n  })"
  }
]
const expectedNames = [
  'openCodexAppServerConnection accepts a realistic 1090188-byte escaped command completion and keeps processing',
  'openCodexAppServerConnection accepts a realistic 2900090-byte escaped command completion and keeps processing',
  'openCodexAppServerConnection accepts a response beyond the daemon wire limit and keeps the provider alive',
  'openCodexAppServerConnection accepts two realistic large command completions without losing either payload',
  'openCodexAppServerConnection advertises the experimental API required for rollout-path resume',
  'openCodexAppServerConnection allows a later close to observe exit after an unproven attempt',
  'openCodexAppServerConnection applies the environment overlay after stripping inherited keys',
  'openCodexAppServerConnection classifies a CLI without the app-server subcommand as unsupported',
  'openCodexAppServerConnection classifies a refusal apart from a missing method',
  'openCodexAppServerConnection completes the handshake and keeps the child alive across calls',
  'openCodexAppServerConnection delivers a notification beyond the daemon wire limit whole, never as an oversized frame',
  'openCodexAppServerConnection does not report recovery for a handler failure until child exit is observed',
  'openCodexAppServerConnection exposes an unproven handshake child for later cleanup',
  'openCodexAppServerConnection fails in-flight requests and reports an unexpected exit once',
  'openCodexAppServerConnection keeps a graceful close quiet when stdin breaks during the reap',
  'openCodexAppServerConnection keeps malformed and non-object JSON non-fatal and processes the next record',
  'openCodexAppServerConnection kills a child that ignores stdin EOF',
  'openCodexAppServerConnection logs a reply to a timed-out request instead of surfacing it as a frame',
  'openCodexAppServerConnection pauses between coalesced records and resumes the retained remainder',
  'openCodexAppServerConnection reaps the child and never handshakes when its spawn cannot be recorded',
  'openCodexAppServerConnection reassembles a message split mid-character across chunks',
  'openCodexAppServerConnection reports one exit for a death that arrives through two listeners',
  'openCodexAppServerConnection reports the spawned pid before it sends the handshake',
  'openCodexAppServerConnection reports unproven close when forced termination did not produce an exit event',
  'openCodexAppServerConnection routes a server request to the handler and writes the reply back',
  'openCodexAppServerConnection shares one eventual exit proof across concurrent close callers',
  'openCodexAppServerConnection starts the provider in the resolved workspace directory',
  "openCodexAppServerConnection surfaces a synchronous 'notification' handler failure as a terminal exit",
  "openCodexAppServerConnection surfaces a synchronous 'server request' handler failure as a terminal exit",
  'openCodexAppServerConnection surfaces valid but unclassified frames instead of dropping them',
  'openCodexAppServerConnection times out one request without ending the connection',
  'openCodexAppServerConnection treats a broken stdin pipe as the end of the transport'
]
const sourcePaths = [
  target,
  'src/main/codex/codex-app-server-connection.ts',
  'src/main/codex/codex-app-server-connection-types.ts',
  'src/main/codex/codex-app-server-exit-error.ts',
  'src/main/codex/codex-app-server-handshake.ts',
  'src/main/codex/codex-app-server-handshake-exit-proof.ts',
  'src/main/codex/codex-app-server-process-teardown.ts',
  'src/main/codex/codex-app-server-posix-supervisor.ts',
  'src/main/codex/codex-app-server-record-dispatch.ts',
  'src/main/codex/codex-app-server-record-reader.ts',
  'src/main/codex/codex-app-server-session.ts',
  'src/main/codex/codex-process-exit-deadline.ts',
  'src/shared/child-process/run-process.ts',
  'src/shared/child-process/retryable-process-exit-proof.ts',
  'src/main/pty-descendant-termination.ts',
  'src/main/pty-descendant-exit-verification.ts',
  'src/main/pty-process-table-parser.ts',
  'src/main/windows-process-tree-kill.ts'
]
const policyPaths = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'config/vitest.config.ts',
  'config/scripts/ci-unit-files.mjs',
  'config/scripts/ci-unit-sequencer.mjs',
  'config/scripts/vitest-real-agent-home-write-guard.ts',
  'config/scripts/happy-dom-offscreen-canvas.ts',
  'config/scripts/happy-dom-mutation-observer-retention.ts',
  'config/scripts/vitest-host-ports-setup.ts',
  'config/scripts/vitest-caller-identity-env-setup.ts',
  'config/scripts/script-child-process.mjs',
  'config/scripts/ci-codex-close-pilot.mjs',
  '.github/workflows/ci-pnpm-verification-pilot.yml',
  '.github/actions/install-node-dependencies/action.yml',
  '.github/actions/prepare-native-runtime/action.yml',
  '.github/actions/restore-pnpm-verification/action.yml',
  'node_modules/vitest/package.json'
]
const hash = (value) => createHash('sha256').update(value).digest('hex')

async function hashes(paths) {
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, hash(await readFile(resolve(workspace, path)))])
    )
  )
}

async function inputs() {
  return { sources: await hashes(sourcePaths), policies: await hashes(policyPaths) }
}

function originalCases(code) {
  assert.equal(hash(code), candidateSourceSha, 'Candidate source changed before pretransform')
  const bodyCounts = []
  for (const replacement of replacements) {
    const count = code.split(replacement.candidate).length - 1
    assert.equal(count, 1, `Candidate case changed: ${replacement.title}`)
    bodyCounts.push({ title: replacement.title, count })
    code = code.replace(replacement.candidate, replacement.original)
  }
  assert.equal(hash(code), originalSourceSha, 'Baseline does not reproduce the full original file')
  return { code, bodyCounts }
}

function timingProof(file, log) {
  assert(
    Number.isFinite(file.startTime) && Number.isFinite(file.endTime),
    'Invalid file timestamps'
  )
  assert(file.endTime >= file.startTime, 'Reversed file timestamps')
  const fileMilliseconds = file.endTime - file.startTime
  assert(Number.isFinite(fileMilliseconds) && fileMilliseconds >= 0, 'Invalid file duration')
  const durationLines = stripVTControlCharacters(log)
    .split('\n')
    .filter((line) => /Duration\s+[\d.]+s/.test(line))
  assert.equal(durationLines.length, 1)
  const phasesMs = Object.fromEntries(
    [
      ...durationLines[0].matchAll(/(transform|setup|import|tests|environment)\s+([\d.]+)(ms|s)/g)
    ].map(([, phase, value, unit]) => [phase, Number(value) * (unit === 's' ? 1000 : 1)])
  )
  assert.equal(Object.keys(phasesMs).length, 5, 'Missing Vitest phases')
  for (const [phase, value] of Object.entries(phasesMs)) {
    assert(Number.isFinite(value) && value >= 0, `Invalid Vitest phase timing: ${phase}`)
  }
  return { fileMilliseconds, phasesMs }
}

await mkdir(output)
assert.equal(
  process.env.PILOT_PNPM_VERSION,
  JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8'))
    .packageManager.split('@')[1]
    .split('+')[0]
)
const sourceHashes = await inputs()
assert.equal(sourceHashes.sources[target], candidateSourceSha)
assert.equal(expectedNames.length, 32)
assert.equal(hash(JSON.stringify(expectedNames)), expectedNamesSha)
const reconstruction = originalCases(await readFile(resolve(workspace, target), 'utf8'))
await writeFile(resolve(output, 'frozen-original.test.ts'), reconstruction.code)
const configs = {}
for (const arm of ['baseline', 'candidate']) {
  configs[arm] = resolve(output, `${arm}.config.mts`)
  const plugin =
    arm === 'baseline'
      ? `[{name:'codex-original-close-baseline',enforce:'pre',transform(code,id){
    if(id.split('?')[0]!==${JSON.stringify(resolve(workspace, target))})return
    const hash=value=>createHash('sha256').update(value).digest('hex')
    const candidateSourceSha=${JSON.stringify(candidateSourceSha)}
    const originalSourceSha=${JSON.stringify(originalSourceSha)}
    const replacements=${JSON.stringify(replacements)}
    const assert={equal(actual,expected,message){if(actual!==expected)throw new Error(message)}}
    ${originalCases.toString()}
    const result=originalCases(code)
    appendFileSync(process.env.ORCA_CODEX_CLOSE_TRANSFORM,JSON.stringify({
      id,pid:process.pid,candidateSha:hash(code),originalSha:hash(result.code),bodyCounts:result.bodyCounts
    })+${JSON.stringify('\n')})
    return {code:result.code,map:null}
  }}]`
      : '[]'
  await writeFile(
    configs[arm],
    `
import {createHash} from 'node:crypto'
import {appendFileSync} from 'node:fs'
import base from ${JSON.stringify(resolve(workspace, 'config/vitest.config.ts'))}
export default {
  ...base,
  plugins:[...(base.plugins??[]),...${plugin}],
  test:{...base.test,maxWorkers:1,fileParallelism:false,
    reporters:['default',['json',{outputFile:process.env.ORCA_CODEX_CLOSE_REPORT}]]}
}
`
  )
}
const summary = {
  identity: {
    node: process.version,
    executable: realpathSync(process.execPath),
    executableSha: hash(await readFile(process.execPath)),
    platform: process.platform,
    arch: process.arch,
    sourceSha: process.env.GITHUB_SHA,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    imageOS: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
    runner: process.env.RUNNER_NAME,
    cpu: process.env.PILOT_CPU,
    kernel: process.env.PILOT_KERNEL,
    pnpm: process.env.PILOT_PNPM_VERSION,
    vitest: JSON.parse(
      await readFile(resolve(workspace, 'node_modules/vitest/package.json'), 'utf8')
    ).version
  },
  sourceHashes,
  originalSourceSha,
  candidateSourceSha,
  expectedCaseNamesSha256: expectedNamesSha,
  reconstruction: { originalSha: hash(reconstruction.code), bodyCounts: reconstruction.bodyCounts },
  orders: [
    ['baseline', 'candidate'],
    ['candidate', 'baseline']
  ],
  runs: [],
  qualified: false,
  methodology:
    'Four full-file native Vitest invocations, one isolated fork each, identical policy and guards. Baseline pretransform restores exactly the two entire original case blocks and the full original source SHA. Candidate runs actual frozen source, including zero-timer cleanup assertions. Same default and JSON reporters; generated test caches are retained across AB/BA arms. Installer and process-wrapper preparation are outside intervals.'
}
await writeFile(resolve(output, 'preflight.json'), `${JSON.stringify(summary, null, 2)}\n`)
try {
  // Prepare the existing process wrapper before either measured arm starts.
  const { spawnProcess } = await import('./script-child-process.mjs')
  for (const [pair, order] of summary.orders.entries()) {
    for (const arm of order) {
      assert.deepEqual(await inputs(), sourceHashes, 'Input source changed before invocation')
      const prefix = resolve(output, `pair-${pair + 1}-${arm}`)
      const chunks = []
      const start = process.hrtime.bigint()
      const child = spawnProcess({
        program: process.execPath,
        args: [
          resolve(workspace, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          configs[arm],
          target
        ],
        cwd: workspace,
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_CODEX_CLOSE_REPORT: `${prefix}.json`,
          ORCA_CODEX_CLOSE_TRANSFORM: `${prefix}.transform.ndjson`,
          FORCE_COLOR: '0'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child.stdout.on('data', (chunk) => chunks.push(chunk))
      child.stderr.on('data', (chunk) => chunks.push(chunk))
      const completion = await new Promise((resolveExit, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => resolveExit({ code, signal }))
      })
      const wallMs = Number(process.hrtime.bigint() - start) / 1e6
      const log = Buffer.concat(chunks).toString()
      await writeFile(`${prefix}.log`, log)
      await writeFile(
        `${prefix}.completion.json`,
        `${JSON.stringify({ pair: pair + 1, arm, completion, wallMs }, null, 2)}\n`
      )
      assert.equal(completion.code, 0, `${arm} failed; see ${prefix}.log`)
      assert.equal(completion.signal, null)
      const report = JSON.parse(await readFile(`${prefix}.json`, 'utf8'))
      assert.equal(report.success, true)
      assert.equal(report.numTotalTests, 32)
      assert.equal(report.numPassedTests, 32)
      for (const key of ['numFailedTests', 'numPendingTests', 'numTodoTests']) {
        assert.equal(report[key], 0)
      }
      assert.equal(report.testResults.length, 1)
      const file = report.testResults[0]
      assert.equal(file.name, resolve(workspace, target))
      assert.equal(file.status, 'passed')
      const cases = file.assertionResults.map((test) => ({
        name: test.fullName,
        status: test.status,
        durationMs: test.duration,
        failureMessages: test.failureMessages
      }))
      assert.equal(cases.length, 32)
      for (const test of cases) {
        assert.equal(test.status, 'passed')
        assert(Number.isFinite(test.durationMs) && test.durationMs >= 0)
        assert.deepEqual(test.failureMessages, [])
      }
      assert.deepEqual(cases.map((test) => test.name).sort(), expectedNames)
      const timings = timingProof(file, log)
      let transforms = []
      if (arm === 'baseline') {
        transforms = (await readFile(`${prefix}.transform.ndjson`, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        assert(transforms.length > 0)
        for (const transform of transforms) {
          assert.equal(transform.candidateSha, candidateSourceSha)
          assert.equal(transform.originalSha, originalSourceSha)
          assert.deepEqual(transform.bodyCounts, reconstruction.bodyCounts)
        }
      } else {
        assert(!existsSync(`${prefix}.transform.ndjson`), 'Candidate source was pretransformed')
      }
      assert.deepEqual(await inputs(), sourceHashes, 'Input source changed after invocation')
      const result = {
        pair: pair + 1,
        arm,
        completion,
        wallMs,
        bodyMs: cases.reduce((sum, test) => sum + test.durationMs, 0),
        ...timings,
        transforms,
        cases
      }
      summary.runs.push(result)
      await writeFile(`${prefix}.receipt.json`, `${JSON.stringify(result, null, 2)}\n`)
      console.log(JSON.stringify({ ...result, cases: cases.length, transforms: transforms.length }))
    }
  }
  assert.equal(summary.runs.length, 4)
  summary.qualified = true
} catch (error) {
  summary.failure = String(error)
  throw error
} finally {
  await writeFile(resolve(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
}
