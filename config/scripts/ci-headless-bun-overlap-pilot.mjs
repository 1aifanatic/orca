import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { pathToFileURL } from 'node:url'
import { NODE_RUNTIME_ASSETS, NODE_RUNTIME_PIN } from '../../src/shared/node-runtime-pin.ts'

const root = resolve(import.meta.dirname, '../..')
const cases = ['A1', 'B1', 'B2', 'A2']
const historicalSha = 'f4092c06d639ee13ad446261dcabc78b27a21fbc'
const currentRoots = [
  'out/orcad',
  'out/orcad-prebuilds',
  'out/orcad-prebuild-work',
  'out/orcad-prebuild-smoke',
  'out/runtimes',
  'out/node-runtime-cache',
  'out/.orcad-watchers'
]
const crossFiles = [
  'src/main/orcad/orcad-cross-runtime-daemon-adoption.integration.test.ts',
  'src/main/persistence/profile-state/profile-state-cross-runtime.integration.test.ts'
]
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const digest = (value) => createHash('sha256').update(value).digest('hex')
const stamp = () => process.hrtime.bigint().toString()
const fileHash = (path) => digest(readFileSync(path))
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const pending = `${path}.${process.pid}.pending`
  writeFileSync(pending, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(pending, path)
}

function inventory(directory) {
  const entries = []
  function walk(path, relative) {
    if (
      directory === join(root, 'node_modules') &&
      ['./.vite', './.vite-temp'].includes(relative)
    ) {
      return
    }
    const stat = lstatSync(path)
    const entry = { path: relative, mode: stat.mode & 0o777 }
    if (stat.isSymbolicLink()) {
      entries.push({ ...entry, type: 'symlink', target: readlinkSync(path) })
    } else if (stat.isDirectory()) {
      entries.push({ ...entry, type: 'directory' })
      for (const name of readdirSync(path).sort()) {
        walk(join(path, name), `${relative}/${name}`)
      }
    } else if (stat.isFile()) {
      entries.push({ ...entry, type: 'file', sha256: fileHash(path) })
    } else {
      throw new Error(`Unsupported inventory entry: ${path}`)
    }
  }
  walk(directory, '.')
  return { sha256: digest(JSON.stringify(entries)), count: entries.length, entries }
}

function identity() {
  const env = process.env
  assert.equal(env.GITHUB_ACTIONS, 'true')
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch')
  assert.equal(env.ORCA_BACKGROUND_LAUNCH, '1')
  assert.equal(process.platform, 'linux')
  assert(['x64', 'arm64'].includes(process.arch))
  assert.equal(env.RUNNER_OS, 'Linux')
  assert.equal(env.RUNNER_ARCH, process.arch === 'x64' ? 'X64' : 'ARM64')
  assert.equal(process.version, env.PILOT_HOST_NODE_VERSION)
  assert.match(process.version, /^v24\./)
  for (const name of [
    'ORCA_NODE_RUNTIME_CACHE_DIR',
    'ORCAD_OUT_DIR',
    'ORCAD_PREBUILDS_DIR',
    'ORCAD_BUILD_TARGET'
  ]) {
    assert(!env[name], `Unexpected builder override: ${name}`)
  }
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/)
  assert.equal(env.PILOT_SOURCE_SHA, env.GITHUB_SHA)
  assert.equal(env.GITHUB_WORKFLOW_SHA, env.GITHUB_SHA)
  assert.match(env.PILOT_TREE_SHA ?? '', /^[a-f0-9]{40}$/)
  assert.match(env.GITHUB_RUN_ID ?? '', /^[0-9]+$/)
  assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/)
  assert(env.ImageOS && env.ImageVersion && env.RUNNER_TEMP && env.PILOT_SOURCE_FILES)
  assert.equal(env.PILOT_BUN_VERSION, '1.4.2')
  assert.equal(
    env.PILOT_PNPM_VERSION,
    readJson(join(root, 'package.json')).packageManager.split('@')[1].split('+')[0]
  )
  return {
    sourceSha: env.GITHUB_SHA,
    treeSha: env.PILOT_TREE_SHA,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    imageOS: env.ImageOS,
    imageVersion: env.ImageVersion,
    runner: env.RUNNER_NAME,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    hostExecutable: realpathSync(process.execPath),
    pnpm: env.PILOT_PNPM_VERSION,
    bun: env.PILOT_BUN_VERSION,
    root: realpathSync(root),
    historicalSha,
    event: env.GITHUB_EVENT_NAME,
    compiler: env.PILOT_COMPILER_VERSION,
    kernel: env.PILOT_KERNEL,
    cpu: env.PILOT_CPU,
    node18Executable: env.PILOT_NODE18_EXECUTABLE || null,
    node18Version: env.PILOT_NODE18_VERSION || null
  }
}

const evidenceRoot = () =>
  join(
    process.env.RUNNER_TEMP,
    `ci-headless-bun-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${process.arch}`
  )
const caseRoot = (id) => join(evidenceRoot(), id)
const plan = () => readJson(join(evidenceRoot(), 'plan.json'))
const partPath = (id, part) => join(caseRoot(id), `${part}.json`)

function sources() {
  const paths = readFileSync(process.env.PILOT_SOURCE_FILES, 'utf8').split('\0').filter(Boolean)
  assert(paths.length > 0)
  return Object.fromEntries(paths.sort().map((path) => [path, fileHash(join(root, path))]))
}

function checkInputs() {
  const expected = plan()
  assert.deepEqual(identity(), expected.identity)
  assert.equal(fileHash(process.execPath), expected.hostExecutableSha)
  assert.equal(digest(JSON.stringify(sources())), expected.sourceDigest)
  const installed = inventory(join(root, 'node_modules'))
  assert.equal(installed.sha256, expected.installed.sha256, 'Shared installed dependencies changed')
  return { sha256: installed.sha256, count: installed.count }
}

function generatedTestCaches() {
  return Object.fromEntries(
    ['.vite', '.vite-temp'].map((name) => {
      const path = join(root, 'node_modules', name)
      return [name, existsSync(path) ? inventory(path) : null]
    })
  )
}

function processRecord(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return {
      pid: Number(pid),
      state: fields[0],
      parent: Number(fields[1]),
      group: Number(fields[2]),
      session: Number(fields[3]),
      started: fields[19]
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') {
      return null
    }
    throw error
  }
}

function live(record) {
  const now = processRecord(record.pid)
  return now && now.started === record.started && !['Z', 'X'].includes(now.state)
}

function ancestors() {
  const result = new Set()
  let pid = process.pid
  while (pid > 1 && !result.has(pid)) {
    result.add(pid)
    pid = processRecord(pid)?.parent ?? 0
  }
  return result
}

function scanOwned(token, records) {
  const known = new Map(records.map((record) => [record.pid, record]))
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    const record = processRecord(pid)
    if (!record || record.pid === process.pid || ['Z', 'X'].includes(record.state)) {
      continue
    }
    let marked = false
    try {
      marked = readFileSync(`/proc/${pid}/environ`)
        .toString()
        .split('\0')
        .includes(`ORCA_CI_BUN_CASE=${token}`)
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) {
        throw error
      }
    }
    const parent = known.get(record.parent)
    if (marked || (parent && live(parent))) {
      known.set(record.pid, record)
    }
  }
  return [...known.values()]
}

async function retire(records, excluded = ancestors()) {
  const remaining = () => records.filter((record) => !excluded.has(record.pid) && live(record))
  const leaked = remaining()
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const record of remaining()) {
      if (live(record)) {
        try {
          process.kill(record.pid, signal)
        } catch (error) {
          if (error.code !== 'ESRCH' || live(record)) {
            throw error
          }
        }
      }
    }
    const until = performance.now() + 5_000
    while (remaining().length && performance.now() < until) {
      await delay(100)
    }
  }
  assert.equal(remaining().length, 0, 'Owned process exit could not be verified')
  return { cleanBefore: leaked.length === 0, leaked, verifiedExited: true }
}

async function observe(id) {
  const begin = readJson(partPath(id, 'begin'))
  let records = []
  let cancelled = false
  const cancel = () => {
    cancelled = true
  }
  process.on('SIGTERM', cancel)
  process.on('SIGINT', cancel)
  writeJson(partPath(id, 'observer-ready'), processRecord(process.pid))
  while (!cancelled && !existsSync(partPath(id, 'observer-stop'))) {
    records = scanOwned(begin.token, records)
    writeJson(partPath(id, 'owned-processes'), records)
    await delay(100)
  }
  records = scanOwned(begin.token, records)
  writeJson(partPath(id, 'owned-processes'), records)
  if (cancelled) {
    writeJson(partPath(id, 'cancel-cleanup'), await retire(records))
  }
  writeJson(partPath(id, 'observer-stopped'), { cancelled, at: stamp() })
}

async function stopObserver(id) {
  writeJson(partPath(id, 'observer-stop'), { at: stamp() })
  const observer = readJson(partPath(id, 'observer-ready'))
  const until = performance.now() + 5_000
  while (live(observer) && performance.now() < until) {
    await delay(100)
  }
  assert(!live(observer), 'The ownership observer did not exit')
  assert(existsSync(partPath(id, 'observer-stopped')))
  assert.equal(readJson(partPath(id, 'observer-stopped')).cancelled, false)
  return retire(readJson(partPath(id, 'owned-processes')))
}

async function resetOutputs() {
  const historical = join(process.env.RUNNER_TEMP, 'bun-orcad-source')
  if (existsSync(historical)) {
    const { runProcessSync } = await import('./script-child-process.mjs')
    const result = runProcessSync({
      program: 'git',
      args: ['worktree', 'remove', '--force', historical],
      cwd: root,
      timeoutMs: 20_000
    })
    assert.equal(result.code, 0, result.stderr)
  }
  for (const path of currentRoots) {
    rmSync(join(root, path), { recursive: true, force: true })
  }
  assert(!existsSync(historical))
  for (const path of currentRoots) {
    assert(!existsSync(join(root, path)))
  }
}

function counts(text) {
  const result = {}
  for (const status of ['passed', 'failed', 'skipped', 'todo']) {
    result[status] = Number(text.match(new RegExp(`(\\d+) ${status}\\b`))?.[1] ?? 0)
  }
  result.total = Number(text.match(/\((\d+)\)\s*$/)?.[1] ?? Number.NaN)
  assert(Number.isSafeInteger(result.total) && result.total > 0)
  assert.equal(result.passed + result.failed + result.skipped + result.todo, result.total)
  assert.equal(result.failed, 0)
  return result
}

function testProof(id) {
  const text = stripVTControlCharacters(readFileSync(join(caseRoot(id), 'artifact.log'), 'utf8'))
  const rows = text.split('\n')
  const summary = (label) => {
    const matching = rows.filter((row) => new RegExp(`^\\s*${label}\\s+`).test(row))
    assert.equal(matching.length, 1, `Missing or duplicate ${label} summary`)
    return counts(matching[0])
  }
  const crossRuntime = crossFiles.map((file) => {
    const matching = rows.filter((row) => row.includes(file) && /\(\d+ tests?/.test(row))
    assert.equal(matching.length, 1, `Missing or duplicate cross-runtime result: ${file}`)
    const row = matching[0]
    const total = Number(row.match(/\((\d+) tests?/)?.[1])
    const skipped = Number(row.match(/\| (\d+) skipped/)?.[1] ?? 0)
    assert.equal(total, 2)
    assert(!/[×✗]/.test(row))
    assert(!/\b(?:todo|failed)\b/.test(row))
    assert([0, 2].includes(skipped))
    if (file.includes('profile-state')) {
      assert.equal(skipped, 0)
    } else {
      const protocol = (directory) =>
        Number(
          readFileSync(join(directory, 'src/main/daemon/daemon-protocol-version.ts'), 'utf8').match(
            /export const PROTOCOL_VERSION = (\d+)/
          )?.[1]
        )
      const currentProtocol = protocol(root)
      const historicalProtocol = protocol(join(process.env.RUNNER_TEMP, 'bun-orcad-source'))
      assert(Number.isSafeInteger(currentProtocol) && Number.isSafeInteger(historicalProtocol))
      assert.equal(skipped, currentProtocol === historicalProtocol ? 0 : 2)
    }
    return { file, total, passed: total - skipped, skipped, transcript: row.trim() }
  })
  const readiness = rows.filter((row) => row.startsWith('{"target":')).map((row) => JSON.parse(row))
  assert.equal(readiness.length, 1)
  const ready = readiness[0]
  assert.equal(ready.runtime, 'node')
  assert.equal(ready.runtimeVersion, NODE_RUNTIME_PIN.version)
  assert.equal(ready.artifactVersion, readFileSync(join(root, 'out/orcad/.version'), 'utf8').trim())
  assert.equal(ready.target, `linux-${process.arch}-glibc`)
  assert.match(ready.nonce, /^[0-9a-f-]{36}$/)
  assert(ready.sqliteVersion && Number.isSafeInteger(ready.revision))
  return { files: summary('Test Files'), cases: summary('Tests'), crossRuntime, readiness: ready }
}

async function artifactProof() {
  const target = `linux-${process.arch}-glibc`
  const asset = NODE_RUNTIME_ASSETS[target]
  const executable = join(root, 'out/runtimes', `node-${asset.executableSha256}`, 'bin/node')
  assert.equal(fileHash(executable), asset.executableSha256)
  const historical = join(process.env.RUNNER_TEMP, 'bun-orcad-source')
  const historicalPin = await import(
    pathToFileURL(join(historical, 'src/shared/orcad-bun-runtime.ts')).href
  )
  const bunAsset = historicalPin.ORCAD_BUN_RELEASE_ASSETS[target]
  const bunSha = fileHash(join(process.env.RUNNER_TEMP, 'bun-orcad/bun-runtime'))
  assert.equal(historicalPin.ORCAD_BUN_VERSION, '1.4.2')
  assert.equal(bunSha, bunAsset.executableSha256)
  return {
    native: inventory(join(root, 'out/orcad-prebuilds')),
    current: inventory(join(root, 'out/orcad')),
    historical: inventory(join(process.env.RUNNER_TEMP, 'bun-orcad')),
    nodeRuntime: { sha256: asset.executableSha256, version: NODE_RUNTIME_PIN.version },
    historicalRuntime: {
      sha256: bunSha,
      archiveSha256: bunAsset.sha256,
      version: historicalPin.ORCAD_BUN_VERSION
    },
    historicalLockfileSha: fileHash(join(historical, 'pnpm-lock.yaml')),
    currentLockfileSha: fileHash(join(root, 'pnpm-lock.yaml')),
    currentVersion: readFileSync(join(root, 'out/orcad/.version'), 'utf8').trim(),
    historicalVersion: readFileSync(
      join(process.env.RUNNER_TEMP, 'bun-orcad/.version'),
      'utf8'
    ).trim()
  }
}

async function main() {
  const [operation, id, part, status] = process.argv.slice(2)
  identity()
  if (operation === 'init') {
    assert(!existsSync(evidenceRoot()))
    for (const path of currentRoots) {
      assert(!existsSync(join(root, path)), `Warm output: ${path}`)
    }
    assert(!existsSync(join(process.env.RUNNER_TEMP, 'bun-orcad-source')))
    assert(!existsSync(join(process.env.RUNNER_TEMP, 'bun-orcad')))
    const source = sources()
    const installed = inventory(join(root, 'node_modules'))
    writeJson(join(evidenceRoot(), 'plan.json'), {
      identity: identity(),
      hostExecutableSha: fileHash(process.execPath),
      cases,
      installed,
      sources: source,
      sourceDigest: digest(JSON.stringify(source)),
      normalizedGitObjectsBeforeTiming: historicalSha,
      gitNormalizationLogSha: fileHash(join(process.env.RUNNER_TEMP, 'bun-git-normalization.log')),
      eventPolicy: 'workflow_dispatch install policy; every measured arm shares it',
      coldRoots: [...currentRoots, '$RUNNER_TEMP/bun-orcad-source', '$RUNNER_TEMP/bun-orcad'],
      generatedTestCaches: generatedTestCaches()
    })
    appendFileSync(process.env.GITHUB_OUTPUT, `receipt-root=${evidenceRoot()}\ncase-count=4\n`)
    return
  }
  if (operation === 'collect') {
    const receipts = []
    for (const caseId of cases) {
      if (
        existsSync(partPath(caseId, 'observer-ready')) &&
        !existsSync(partPath(caseId, 'observer-stopped'))
      ) {
        try {
          writeJson(partPath(caseId, 'collection-cleanup'), await stopObserver(caseId))
        } catch (error) {
          writeJson(partPath(caseId, 'collection-cleanup'), {
            verifiedExited: false,
            error: error.message
          })
        }
      }
      if (existsSync(partPath(caseId, 'receipt'))) {
        receipts.push(readJson(partPath(caseId, 'receipt')))
      } else if (existsSync(partPath(caseId, 'begin'))) {
        receipts.push({
          ...readJson(partPath(caseId, 'begin')),
          qualified: false,
          incomplete: true
        })
      }
    }
    writeJson(join(evidenceRoot(), 'comparison.json'), {
      identity: identity(),
      expected: cases,
      receipts
    })
    assert.equal(receipts.length, 4, 'Incomplete comparison; keep partial evidence')
    for (const receipt of receipts) {
      assert.equal(receipt.qualified, true)
    }
    for (const receipt of receipts.slice(1)) {
      assert.deepEqual(receipt.tests.files, receipts[0].tests.files)
      assert.deepEqual(receipt.tests.cases, receipts[0].tests.cases)
      assert.deepEqual(
        receipt.tests.crossRuntime.map(({ transcript: _transcript, ...value }) => value),
        receipts[0].tests.crossRuntime.map(({ transcript: _transcript, ...value }) => value)
      )
    }
    await resetOutputs()
    rmSync(join(process.env.RUNNER_TEMP, 'bun-orcad'), { recursive: true, force: true })
    return
  }
  assert(cases.includes(id))
  if (operation === 'begin') {
    assert(!existsSync(caseRoot(id)))
    const previous = cases[cases.indexOf(id) - 1]
    if (previous) {
      assert.equal(readJson(partPath(previous, 'receipt')).qualified, true)
    }
    await resetOutputs()
    rmSync(join(process.env.RUNNER_TEMP, 'bun-orcad'), { recursive: true, force: true })
    const before = checkInputs()
    const token = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${process.arch}-${id}-${randomUUID()}`
    writeJson(partPath(id, 'begin'), {
      id,
      mode: id[0] === 'A' ? 'serial' : 'overlap',
      token,
      before,
      generatedTestCachesBefore: generatedTestCaches()
    })
    const { spawnProcess } = await import('./script-child-process.mjs')
    const child = spawnProcess({
      program: process.execPath,
      args: [import.meta.filename, 'observe', id],
      env: { ...process.env, ORCA_CI_BUN_CASE: token },
      stdio: 'ignore',
      detached: true
    })
    child.unref()
    const until = performance.now() + 5_000
    while (!existsSync(partPath(id, 'observer-ready')) && performance.now() < until) {
      await delay(25)
    }
    assert(existsSync(partPath(id, 'observer-ready')), 'Ownership observer did not start')
    appendFileSync(
      process.env.GITHUB_ENV,
      `PILOT_CASE=${id}\nPILOT_CASE_DIR=${caseRoot(id)}\nORCA_CI_BUN_CASE=${token}\n`
    )
    writeJson(partPath(id, 'window-start'), { at: stamp() })
    return
  }
  if (operation === 'observe') {
    return observe(id)
  }
  if (operation === 'start' || operation === 'end') {
    assert(['node', 'bun', 'artifact', 'node18'].includes(part))
    const path = partPath(id, `${part}-${operation}`)
    assert(!existsSync(path))
    writeJson(path, { at: stamp(), ...(operation === 'end' ? { status: Number(status) } : {}) })
    if (operation === 'end') {
      assert.equal(Number(status), 0, `${part} failed`)
    }
    return
  }
  if (operation === 'ready') {
    const now = stamp()
    const node = readJson(partPath(id, 'node-end'))
    const bun = readJson(partPath(id, 'bun-end'))
    assert.equal(node.status, 0)
    assert.equal(bun.status, 0)
    if (id[0] === 'A') {
      assert(BigInt(node.at) <= BigInt(readJson(partPath(id, 'bun-start')).at))
    }
    writeJson(partPath(id, 'window-end'), { at: now, nativeJoin: id[0] === 'B' })
    return
  }
  assert.equal(operation, 'finish')
  const receipt = { ...readJson(partPath(id, 'begin')), identity: identity(), qualified: false }
  writeJson(partPath(id, 'receipt'), receipt)
  const start = readJson(partPath(id, 'window-start'))
  const end = readJson(partPath(id, 'window-end'))
  receipt.preparationMilliseconds = Number(BigInt(end.at) - BigInt(start.at)) / 1e6
  receipt.nativeJoin = end.nativeJoin
  receipt.parts = Object.fromEntries(
    ['node', 'bun', 'artifact', ...(process.arch === 'x64' ? ['node18'] : [])].map((name) => {
      const first = readJson(partPath(id, `${name}-start`))
      const last = readJson(partPath(id, `${name}-end`))
      assert.equal(last.status, 0)
      return [
        name,
        {
          ...first,
          end: last.at,
          status: last.status,
          milliseconds: Number(BigInt(last.at) - BigInt(first.at)) / 1e6
        }
      ]
    })
  )
  receipt.after = checkInputs()
  receipt.generatedTestCachesAfter = generatedTestCaches()
  receipt.artifacts = await artifactProof()
  receipt.tests = testProof(id)
  if (process.arch === 'x64') {
    assert.match(process.env.PILOT_NODE18_VERSION ?? '', /^v18\./)
    const preflight = readJson(join(caseRoot(id), 'node18-preflight.json'))
    assert.equal(preflight.runtime, 'node')
    assert.equal(preflight.runtimeVersion, NODE_RUNTIME_PIN.version)
    assert.equal(preflight.nonce, '00000000-0000-4000-8000-000000000018')
    assert.equal(preflight.artifactVersion, receipt.artifacts.currentVersion)
    receipt.node18 = { executableSha: fileHash(process.env.PILOT_NODE18_EXECUTABLE), preflight }
  }
  receipt.cleanup = await stopObserver(id)
  receipt.qualified = receipt.cleanup.cleanBefore
  writeJson(partPath(id, 'receipt'), receipt)
  assert.equal(receipt.qualified, true, 'Owned processes survived the completed oracle')
}

if (resolve(process.argv[1]) === import.meta.filename) {
  await main()
}
