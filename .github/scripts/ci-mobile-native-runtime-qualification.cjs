const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '../..')
const reportDirectory = () => process.env.ORCA_CI_NATIVE_REPORT_DIRECTORY
const write = (name, value) => {
  fs.mkdirSync(reportDirectory(), { recursive: true })
  fs.writeFileSync(path.join(reportDirectory(), name), `${JSON.stringify(value, null, 2)}\n`)
}
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const configuration = () =>
  JSON.parse(fs.readFileSync(process.env.ORCA_CI_NATIVE_GUARD_CONFIG, 'utf8'))
const guardOptions = () =>
  `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(__filename)}`.trim()

function installGuard() {
  const config = configuration()
  const allowed = fs.realpathSync(config.toolchain.path)
  if (hash(allowed) !== config.toolchain.sha256) {
    throw new Error('Shipped toolchain binding changed')
  }
  const record = (event) =>
    fs.appendFileSync(
      config.events,
      `${JSON.stringify({
        pid: process.pid,
        parentPid: process.ppid,
        control: process.env.ORCA_CI_NATIVE_GUARD_CONTROL || null,
        ...event
      })}\n`
    )
  record({ event: 'worker-boot', threadId: require('node:worker_threads').threadId })
  const verify = (filename, hook) => {
    let resolved
    try {
      resolved = fs.realpathSync(filename)
    } catch {
      resolved = path.resolve(filename)
    }
    const permitted = resolved === allowed
    record({ event: 'native-attempt', hook, filename: resolved, permitted })
    if (!permitted) {
      throw new Error(`CI qualification refuses native runtime .node load: ${filename}`)
    }
  }
  const dlopen = process.dlopen
  process.dlopen = function (module, filename, ...args) {
    verify(filename, 'dlopen')
    return dlopen.call(this, module, filename, ...args)
  }
  const extensions = require('node:module')._extensions
  const load = extensions['.node']
  extensions['.node'] = function (module, filename) {
    verify(filename, 'extension')
    return load.call(this, module, filename)
  }
}

function configure() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Hosted qualification requires Linux x64')
  }
  fs.mkdirSync(reportDirectory(), { recursive: true })
  const binding = fs.realpathSync(
    require.resolve('@rolldown/binding-linux-x64-gnu', {
      paths: [path.dirname(require.resolve('rolldown/package.json'))]
    })
  )
  const file = path.join(reportDirectory(), 'guard-config.json')
  write('guard-config.json', {
    toolchain: { package: '@rolldown/binding-linux-x64-gnu', path: binding, sha256: hash(binding) },
    events: path.join(reportDirectory(), 'native-events.jsonl')
  })
  fs.appendFileSync(
    process.env.GITHUB_ENV,
    `ORCA_CI_NATIVE_GUARD_CONFIG=${file}\nORCA_CI_NATIVE_GUARD_OPTIONS=${guardOptions()}\n`
  )
}

async function negativeControl(mode) {
  let addon
  try {
    addon = path.join(
      path.dirname(require.resolve('node-pty/package.json')),
      'build',
      'Release',
      'pty.node'
    )
  } catch {}
  const real = mode !== 'synthetic' && addon && fs.existsSync(addon)
  if (!real) {
    if (mode === 'require-real') {
      throw new Error('Warm restored node-pty binary missing for real negative control')
    }
    addon = path.join(
      reportDirectory(),
      'negative-control',
      'node-pty',
      'build',
      'Release',
      'pty.node'
    )
    fs.mkdirSync(path.dirname(addon), { recursive: true })
    fs.writeFileSync(addon, '')
  }
  const { runProcessSync } = await import(
    pathToFileURL(path.join(root, 'config/scripts/script-child-process.mjs')).href
  )
  const result = runProcessSync({
    program: process.execPath,
    args: [
      '--eval',
      `try { require(${JSON.stringify(addon)}); process.exit(2) } catch(error) { if (!error.message.startsWith('CI qualification refuses native runtime .node load:')) throw error; console.log('guard-denied') }`
    ],
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: guardOptions(),
      ORCA_CI_NATIVE_GUARD_CONTROL: real ? 'real-node-pty' : 'synthetic-node-pty'
    },
    timeoutMs: 30_000
  })
  const receipt = {
    real: Boolean(real),
    addon,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr
  }
  write(`negative-control-${real ? 'real' : 'synthetic'}.json`, receipt)
  if (result.code !== 0 || !result.stdout.includes('guard-denied')) {
    throw new Error('Native-load negative control failed')
  }
}

function summarizeGuard() {
  const config = configuration()
  const events = fs
    .readFileSync(config.events, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse)
  const workers = new Set(
    events
      .filter((row) => row.event === 'worker-boot' && !row.control)
      .map((row) => `${row.pid}:${row.threadId}`)
  )
  const unexpected = events.filter(
    (row) => row.event === 'native-attempt' && !row.permitted && !row.control
  )
  const controls = events.filter(
    (row) => row.event === 'native-attempt' && !row.permitted && row.control
  )
  write('guard-summary.json', {
    toolchain: config.toolchain,
    workerBoots: workers.size,
    unexpected,
    controls,
    events: events.length
  })
  if (workers.size < 3 || unexpected.length || !controls.length) {
    throw new Error('Guard inheritance or runtime-load qualification failed')
  }
}

function stageLabel(label) {
  if (!/^[1-3]-(node|none)$/.test(label)) {
    throw new Error('Invalid paired stage label')
  }
  return label
}

function startStage(label) {
  stageLabel(label)
  const capturedNs = process.hrtime.bigint()
  const wrapperMs = performance.now()
  write(`${label}-start.json`, {
    epochMs: performance.timeOrigin,
    monotonicNs: (capturedNs - BigInt(Math.round(wrapperMs * 1e6))).toString(),
    startWrapperToTimestampMs: wrapperMs
  })
}

function finishStage(label) {
  stageLabel(label)
  const finishNs = process.hrtime.bigint()
  const start = JSON.parse(
    fs.readFileSync(path.join(reportDirectory(), `${label}-start.json`), 'utf8')
  )
  const mode = label.split('-')[1]
  const cacheHit = process.env.NATIVE_CACHE_HIT === 'true'
  const receipt = {
    pair: Number(label[0]),
    mode,
    measurement: 'prepare-native-runtime stage, not workflow or PR runtime',
    elapsedMs: Number(finishNs - BigInt(start.monotonicNs)) / 1e6,
    startWrapperToTimestampMs: start.startWrapperToTimestampMs,
    finishWrapperToTimestampMs: performance.now(),
    includes: [
      'start Node wrapper startup/receipt write/process exit',
      'runner step transitions',
      'composite validation/cache restore/runtime probes',
      'finish wrapper startup'
    ],
    excludes: [
      'dependency/browser installation',
      'production build/tests',
      'job/workflow queueing',
      'native cache saving (disabled)'
    ],
    nativeCacheHit: cacheHit,
    nativeCacheKey: process.env.NATIVE_CACHE_KEY || null,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    sourceSha: process.env.GITHUB_SHA,
    runnerImage: process.env.ImageVersion,
    valid: mode === 'none' || (cacheHit && Boolean(process.env.NATIVE_CACHE_KEY))
  }
  write(`${label}.json`, receipt)
  if (!receipt.valid) {
    throw new Error(
      'Exact warm native cache hit required; seed main cache separately before retrying'
    )
  }
}

function summarizeStages() {
  const pairs = [1, 2, 3].map((pair) => {
    const read = (mode) =>
      JSON.parse(fs.readFileSync(path.join(reportDirectory(), `${pair}-${mode}.json`), 'utf8'))
    const node = read('node')
    const none = read('none')
    if (!node.valid || !none.valid) {
      throw new Error('Invalid paired stage receipt')
    }
    return {
      pair,
      nodeMs: node.elapsedMs,
      noneMs: none.elapsedMs,
      savedMs: node.elapsedMs - none.elapsedMs,
      nativeCacheKey: node.nativeCacheKey
    }
  })
  if (new Set(pairs.map((pair) => pair.nativeCacheKey)).size !== 1) {
    throw new Error('Paired stages restored different native cache keys')
  }
  write('paired-stage-summary.json', {
    measurement: 'paired prepare-native-runtime stages including boundary/step overhead',
    order: ['node', 'none', 'none', 'node', 'node', 'none'],
    pairs
  })
}

async function main() {
  const [command, label] = process.argv.slice(2)
  if (command === 'configure') {
    configure()
  } else if (command === 'negative-control') {
    await negativeControl(label)
  } else if (command === 'summarize-guard') {
    summarizeGuard()
  } else if (command === 'stage-start') {
    startStage(label)
  } else if (command === 'stage-finish') {
    finishStage(label)
  } else if (command === 'summarize-stages') {
    summarizeStages()
  } else {
    throw new Error('Unknown qualification command')
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
} else {
  installGuard()
}
