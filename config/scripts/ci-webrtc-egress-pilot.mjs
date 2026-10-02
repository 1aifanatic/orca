import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { Script } from 'node:vm'
import ts from 'typescript-api'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'
import { describeProcessFailure, runProcessSync } from './script-child-process.mjs'

const repository = resolve(import.meta.dirname, '../..')
const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    'prepare-only': { type: 'boolean', default: false },
    'controls-only': { type: 'boolean', default: false },
    'candidate-first': { type: 'boolean', default: false }
  }
})
assert(values.output, '--output is required')
const output = resolve(values.output)
mkdirSync(output, { recursive: true })
const require = createRequire(import.meta.url)
const fixture = 'src/main/browser/browser-route-webrtc-egress.electron.test.ts'
const fixturePath = join(repository, fixture)
const frozenPath = join(import.meta.dirname, 'ci-webrtc-egress-pilot-baseline.txt')
const baseline = readFileSync(frozenPath, 'utf8')
const candidate = readFileSync(fixturePath, 'utf8')
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const frozenSha256 = '28153099c23770ba71bd2f2a6dd192c97e8fb712679524aedf4733d26394d6be'
const graphicsPolicy = [
  '// This data-channel probe does not need Linux GPU initialization.',
  "if (process.platform === 'linux') app.disableHardwareAcceleration()"
].join('\n')
assert.equal(sha256(baseline), frozenSha256, '8ff6296 baseline fixture changed')
assert.equal(
  candidate,
  baseline.replace(
    "const { app, BrowserWindow, session } = require('electron')",
    `const { app, BrowserWindow, session } = require('electron')\n${graphicsPolicy}`
  ),
  'Candidate must change only the Linux graphics policy'
)
const runs = []
const controls = []
const validationErrors = []
const requiredPhases = [
  'boot',
  'bind-listeners',
  'configure-proxy',
  'close-connections',
  'resolve-proxy',
  'create-window',
  'load-page',
  'renderer-webrtc',
  'observe-packets',
  'close-peer',
  'drain-packets',
  'cleanup',
  'write-result'
]

function inputCensus() {
  const files = new Set()
  const pending = [
    fixturePath,
    frozenPath,
    import.meta.filename,
    join(repository, 'config/vitest.config.ts'),
    join(repository, 'package.json'),
    join(repository, 'pnpm-lock.yaml'),
    join(repository, 'src/shared/child-process/run-process.ts'),
    ...[
      'vitest-real-agent-home-write-guard.ts',
      'happy-dom-offscreen-canvas.ts',
      'happy-dom-mutation-observer-retention.ts',
      'vitest-host-ports-setup.ts',
      'vitest-caller-identity-env-setup.ts'
    ].map((file) => join(import.meta.dirname, file)),
    require.resolve('electron/package.json'),
    require.resolve('vitest/package.json')
  ]
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
        ...['.ts', '.tsx', '.mjs', '.js', '.json'].map((ext) => base + ext),
        join(base, 'index.ts')
      ].find((path) => existsSync(path) && statSync(path).isFile())
      if (resolved) {
        pending.push(resolved)
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
  assert.equal(sha256(JSON.stringify(inputCensus())), inputHash, 'Reachable inputs changed')
writeFileSync(join(output, 'inputs.json'), JSON.stringify({ inputHash, files: census }, null, 2))

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Expected one transform target: ${before}`)
  return source.replace(before, after)
}

function instrument(source, captured) {
  source = replaceOnce(
    source,
    "let phase = 'app-ready'",
    [
      "const { performance } = require('node:perf_hooks')",
      'const started = performance.now()',
      "const phases = [{ phase: 'boot', ms: 0 }]",
      "let phase = 'app-ready'"
    ].join('\n')
  )
  source = replaceOnce(
    source,
    '  phase = next',
    '  phase = next\n  phases.push({ phase, ms: performance.now() - started })'
  )
  source = replaceOnce(
    source,
    "  udp.on('message', (message) => packets.push(message.length))",
    [
      '  const packetTimes = []',
      "  udp.on('message', (message) => {",
      '    packets.push(message.length)',
      "    packetTimes.push({ phase, ms: performance.now() - started, bytes: message.length, injected: message.toString() === 'pilot-late-udp' })",
      '  })'
    ].join('\n')
  )
  source = replaceOnce(
    source,
    '      const peer = new RTCPeerConnection({',
    [
      '      const rendererPhases = []',
      '      const mark = (phase) => rendererPhases.push({ phase, ms: performance.now() })',
      "      mark('peer-start')",
      '      const peer = new RTCPeerConnection({'
    ].join('\n')
  )
  source = replaceOnce(
    source,
    '      globalThis.__webrtcEgressPeer = peer',
    "      mark('peer-created')\n      globalThis.__webrtcEgressPeer = peer"
  )
  source = replaceOnce(
    source,
    "      peer.createDataChannel('probe')",
    "      peer.createDataChannel('probe')\n      mark('channel-created')"
  )
  source = replaceOnce(
    source,
    '      const offer = await peer.createOffer()',
    "      const offer = await peer.createOffer()\n      mark('offer-created')"
  )
  source = replaceOnce(
    source,
    '      await peer.setLocalDescription(offer)',
    "      await peer.setLocalDescription(offer)\n      mark('description-set')\n      return rendererPhases"
  )
  source = replaceOnce(
    source,
    '  await window.webContents.executeJavaScript(script)',
    '  const rendererPhases = await window.webContents.executeJavaScript(script)'
  )
  source = replaceOnce(
    source,
    '  return { packets: packets.length, policy, resolvedProxy }',
    '  return { packets: packets.length, policy, resolvedProxy, phases, rendererPhases, packetTimes }'
  )
  source = source.replaceAll(
    'phase, protectedGuest: ${protectedGuest}',
    'phase, phases, protectedGuest: ${protectedGuest}'
  )
  source = replaceOnce(
    source,
    "import { spawnSync } from 'node:child_process'",
    "import { appendFileSync } from 'node:fs'\nimport { spawnSync } from 'node:child_process'"
  )
  return replaceOnce(
    source,
    '  expect(run.error).toBeUndefined()',
    [
      `  appendFileSync(${JSON.stringify(captured)}, JSON.stringify({ protectedGuest, status: run.status, signal: run.signal, error: run.error?.message ?? null, rawResult, stdout: run.stdout, stderr: run.stderr }) + '\\n')`,
      '  expect(run.error).toBeUndefined()'
    ].join('\n')
  )
}

function validateGeneratedSource(source, label) {
  const parsed = ts.createSourceFile(`${label}.ts`, source, ts.ScriptTarget.Latest, true)
  assert.equal(parsed.parseDiagnostics.length, 0, `Invalid transformed source: ${label}`)
  const declaration = parsed.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'probeMain'
  )
  assert(declaration, 'Existing probe generator is missing')
  const compiled = ts.transpileModule(declaration.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const generate = new Function(`${compiled}\nreturn probeMain`)()
  for (const protectedGuest of [false, true]) {
    const script = generate(join(output, `${label}-result.json`), protectedGuest)
    new Script(script, { filename: `${label}-${protectedGuest}.cjs` })
    assert(
      script.includes('setTimeout(resolve, 3000)') && script.includes('setTimeout(resolve, 500)'),
      'Packet windows changed'
    )
    assert(script.includes('}, 20000)'), 'Child watchdog changed')
    writeFileSync(join(output, `${label}-${protectedGuest}.cjs`), script)
  }
}

function prepare(label, source, mutate) {
  const report = join(output, `${label}.json`)
  const captured = join(output, `${label}-probes.jsonl`)
  writeFileSync(captured, '')
  let transformed = instrument(source, captured)
  if (mutate) {
    transformed = mutate(transformed)
  }
  validateGeneratedSource(transformed, label)
  const path = join(output, `${label}.config.ts`)
  writeFileSync(
    path,
    [
      `import { mergeConfig } from ${JSON.stringify(require.resolve('vitest/config'))}`,
      `import config from ${JSON.stringify(join(repository, 'config/vitest.config.ts'))}`,
      'export default mergeConfig(config, {plugins:[{name:"fixed-webrtc-egress-arm",enforce:"pre",transform(_code,id){',
      `if(id.split("?")[0].replaceAll("\\\\","/") === ${JSON.stringify(fixturePath.replaceAll('\\', '/'))}) return ${JSON.stringify(transformed)}`,
      `}}],test:${JSON.stringify({ maxWorkers: 1, isolate: true, pool: 'forks', reporters: ['default', 'json'], outputFile: report })}})`
    ].join('\n')
  )
  return { label, path, report, captured, log: join(output, `${label}.log`) }
}

function invoke(config) {
  assertInputs()
  const started = performance.now()
  const result = runProcessSync({
    program: process.execPath,
    args: [
      join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
      'run',
      '--config',
      config.path,
      fixture
    ],
    cwd: repository,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 120_000,
    maxOutputBytes: 2 * 1024 * 1024
  })
  const processMs = performance.now() - started
  writeFileSync(config.log, [result.stdout, result.stderr].join('\n'))
  assertInputs()
  assert(!result.timedOut && !result.outputTruncated, describeProcessFailure(result))
  const report = JSON.parse(readFileSync(config.report, 'utf8'))
  const assertions = report.testResults.flatMap((file) => file.assertionResults)
  const names = assertions.map((test) => [test.fullName, test.status])
  assert.equal(names.length, 1, 'Exactly the unchanged WebRTC case must run')
  assert.equal(
    names[0][0],
    'browser route WebRTC egress under Electron blocks direct UDP after applying the exact guest policy'
  )
  const probes = readFileSync(config.captured, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const record = JSON.parse(line)
      return {
        ...record,
        result: record.rawResult === 'no result' ? null : JSON.parse(record.rawResult)
      }
    })
  return {
    label: config.label,
    code: result.code,
    processMs,
    bodyMs: assertions[0].duration,
    names,
    probes
  }
}

function requireSuccess(run, reference) {
  assert.equal(run.code, 0, `${run.label}: invocation failed`)
  assert.equal(run.names[0][1], 'passed')
  if (reference) {
    assert.deepEqual(run.names, reference.names)
  }
  assert.deepEqual(
    run.probes.map((probe) => probe.protectedGuest),
    [false, true]
  )
  for (const probe of run.probes) {
    assert.equal(probe.status, 0)
    assert.equal(probe.error, null)
    assert.equal(probe.signal, null)
    assert(probe.result && !probe.result.error)
    assert.match(probe.result.resolvedProxy, /^SOCKS5 127\.0\.0\.1:\d+$/)
    assert.equal(probe.result.policy, probe.protectedGuest ? 'disable_non_proxied_udp' : 'default')
    assert(probe.protectedGuest ? probe.result.packets === 0 : probe.result.packets > 0)
    assert.equal(probe.result.packetTimes.length, probe.result.packets)
    assert.deepEqual(
      probe.result.phases.map((entry) => entry.phase),
      requiredPhases
    )
    const times = Object.fromEntries(probe.result.phases.map((entry) => [entry.phase, entry.ms]))
    assert(times['close-peer'] - times['observe-packets'] >= 2990, 'Observation was shortened')
    assert(times.cleanup - times['drain-packets'] >= 490, 'Drain was shortened')
    assert.deepEqual(
      probe.result.rendererPhases.map((entry) => entry.phase),
      ['peer-start', 'peer-created', 'channel-created', 'offer-created', 'description-set']
    )
  }
}

function validateRun(run, validate) {
  try {
    validate()
    return true
  } catch (error) {
    validationErrors.push({ label: run.label, error: String(error?.stack || error) })
    return false
  }
}

function injectPacket(source, phase, delay) {
  return replaceOnce(
    source,
    `  enterPhase('${phase}')`,
    [
      `  enterPhase('${phase}')`,
      '  if (${protectedGuest}) {',
      "    const injected = dgram.createSocket('udp4')",
      `    setTimeout(() => injected.send(Buffer.from('pilot-late-udp'), udpAddress.port, '127.0.0.1', () => injected.close()), ${delay})`,
      '  }'
    ].join('\n')
  )
}
const controlDefinitions = [
  {
    name: 'omitted-policy',
    mutate: (source) =>
      replaceOnce(
        source,
        "window.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')",
        "window.webContents.setWebRTCIPHandlingPolicy('default')"
      ),
    check(run) {
      const result = run.probes[1].result
      assert.equal(result.policy, 'default')
      assert(result.packets > 0, 'Missing policy must produce actual UDP')
    }
  },
  ...[
    ['late-observation', 'observe-packets', 2900],
    ['late-drain', 'drain-packets', 250]
  ].map(([name, phase, delay]) => ({
    name,
    mutate: (source) => injectPacket(source, phase, delay),
    check(run) {
      const result = run.probes[1].result
      assert.equal(result.policy, 'disable_non_proxied_udp')
      assert.equal(result.packets, 1)
      const packet = result.packetTimes.find((packet) => packet.injected)
      assert(
        packet && packet.phase === phase,
        'Late injected packet must be observed in its original phase'
      )
      const start = result.phases.find((entry) => entry.phase === phase).ms
      assert(packet.ms - start >= delay - 10)
    }
  })),
  {
    name: 'missing-factory',
    mutate: (source) =>
      replaceOnce(source, 'new RTCPeerConnection({', 'new MissingPilotPeerConnection({'),
    check(run) {
      assert.equal(run.probes.length, 1)
      assert.equal(run.probes[0].status, 1)
      assert.match(run.probes[0].result.error, /MissingPilotPeerConnection/)
      assert.equal(run.probes[0].result.phase, 'renderer-webrtc')
    }
  },
  {
    name: 'missing-local-description',
    mutate: (source) =>
      replaceOnce(
        source,
        'await peer.setLocalDescription(offer)',
        'if (${protectedGuest}) await peer.setLocalDescription(offer)'
      ),
    check(run) {
      assert.equal(run.probes[0].result.packets, 0)
      assert.equal(run.probes[1].result.packets, 0)
    }
  },
  {
    name: 'zero-baseline-counter',
    mutate: (source) => replaceOnce(source, 'packets.push(message.length)', 'void message.length'),
    check(run) {
      assert.equal(run.probes[0].result.packets, 0)
      assert(
        run.probes[0].result.packetTimes.length > 0,
        'Broken counter must fail despite actual UDP'
      )
    }
  },
  {
    name: 'hung-renderer',
    mutate: (source) =>
      replaceOnce(source, "mark('peer-start')", "mark('peer-start'); await new Promise(() => {})"),
    check(run) {
      assert.equal(run.probes.length, 1)
      assert.equal(run.probes[0].status, 2)
      assert.equal(run.probes[0].result.error, 'WebRTC egress probe timed out')
      assert.equal(run.probes[0].result.phase, 'renderer-webrtc')
    }
  }
]

const prepared = [prepare('prepared-baseline', baseline), prepare('prepared-candidate', candidate)]
const preparedControls = controlDefinitions.map((control) => ({
  ...control,
  config: prepare(`control-${control.name}`, candidate, control.mutate)
}))
if (values['prepare-only']) {
  console.log(
    JSON.stringify({
      inputHash,
      frozenSha256,
      candidateSha256: sha256(candidate),
      configs: prepared.map((config) => config.path),
      controls: preparedControls.map((control) => control.name)
    })
  )
} else {
  assert.equal(process.platform, 'linux', 'Actual Electron launches belong on hosted Linux')
  assert.equal(process.arch, 'x64', 'Use the Linux package runner architecture')
  assert(process.env.DISPLAY, 'Launch the driver under isolated xvfb-run')
  try {
    if (!values['controls-only']) {
      let reference
      for (let pair = 1; pair <= 3; pair++) {
        const candidateFirst = values['candidate-first'] === (pair % 2 === 1)
        for (const arm of candidateFirst ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
          const run = invoke(
            prepare(`timed-${pair}-${arm}`, arm === 'baseline' ? baseline : candidate)
          )
          const valid = validateRun(run, () => requireSuccess(run, reference))
          runs.push({ ...run, pair, arm, valid })
          if (valid) {
            reference ??= run
          }
          console.log(
            JSON.stringify({
              label: run.label,
              processMs: run.processMs,
              bodyMs: run.bodyMs,
              valid,
              packets: run.probes.map((probe) => probe.result?.packets)
            })
          )
        }
      }
    }
    for (const control of preparedControls) {
      const run = invoke(control.config)
      const valid = validateRun(run, () => {
        assert.equal(run.code, 1, `${control.name}: mutation must fail`)
        assert.equal(run.names[0][1], 'failed')
        control.check(run)
      })
      controls.push({ ...run, fault: control.name, valid })
      console.log(JSON.stringify({ fault: control.name, status: valid ? 'caught' : 'invalid' }))
    }
    assert.equal(
      validationErrors.length,
      0,
      'Every original assertion and fault control must qualify'
    )
  } finally {
    const timings = Object.fromEntries(
      ['baseline', 'candidate'].map((arm) => {
        const selected = runs.filter((run) => run.arm === arm)
        return [
          arm,
          selected.length === 3 && selected.every((run) => run.valid)
            ? {
                process: summarizeBenchmarkSamples(selected.map((run) => run.processMs)),
                body: summarizeBenchmarkSamples(selected.map((run) => run.bodyMs))
              }
            : null
        ]
      })
    )
    writeFileSync(
      join(output, 'summary.json'),
      JSON.stringify(
        {
          source: process.env.GITHUB_SHA,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          firstArm: values['candidate-first'] ? 'candidate' : 'baseline',
          candidateFirst: values['candidate-first'],
          order: runs.map((run) => run.arm),
          inputHash,
          frozenSha256,
          candidateSha256: sha256(candidate),
          qualified:
            validationErrors.length === 0 &&
            controls.length === 7 &&
            (values['controls-only'] || runs.length === 6),
          validationErrors,
          timings,
          runs,
          controls
        },
        null,
        2
      )
    )
  }
}
