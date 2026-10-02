import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { describeProcessFailure, runProcessSync, spawnProcess } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
if (process.platform !== 'linux' || !process.env.RUNNER_TEMP || !process.env.CI) {
  throw new Error('This pilot requires an isolated Linux hosted job with RUNNER_TEMP.')
}
const base = process.env.BASE_SHA
if (!/^[a-f0-9]{40}$/.test(base ?? '')) {
  throw new Error('BASE_SHA must be an exact baseline commit.')
}
const output = join(process.env.RUNNER_TEMP, 'daemon-fixture-trim-pilot')
const scratch = join(process.env.RUNNER_TEMP, `daemon-trim-${process.pid}`)
if (
  Buffer.byteLength(join(scratch, 'pair-3-candidate', 'exec/containerd/containerd.sock.ttrpc')) >
  107
) {
  throw new Error('RUNNER_TEMP is too long for the private containerd Unix socket.')
}
mkdirSync(output, { recursive: true })
mkdirSync(scratch, { recursive: true })
const report = { base, node: process.version, daemons: [], images: {}, samples: [] }
const save = () => writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2))
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const containerRun = ['run', '--rm', '--network=none']
const imageBuild = ['build', '--progress=plain', '--platform', 'linux/amd64']

function run(program, args, label, { allowFailure = false, timeoutMs = 600_000 } = {}) {
  const started = performance.now()
  const result = runProcessSync({
    program,
    args,
    cwd: root,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs,
    maxOutputBytes: 32 * 1024 * 1024
  })
  const ms = performance.now() - started
  writeFileSync(join(output, `${label}.log`), `${result.stdout}\n${result.stderr}`)
  if (result.timedOut || result.outputTruncated || (!allowFailure && result.code !== 0)) {
    throw new Error(`${label}: ${describeProcessFailure(result)}`)
  }
  return { ...result, ms }
}

async function withDaemon(name, operation) {
  const directory = join(scratch, name)
  const socket = join(directory, 'docker.sock')
  const pidFile = join(directory, 'dockerd.pid')
  mkdirSync(directory)
  const child = spawnProcess({
    program: 'sudo',
    args: [
      '-n',
      'sh',
      '-c',
      'exec dockerd "$@" > "$0" 2>&1',
      join(output, `${name}-dockerd.log`),
      '--data-root',
      join(directory, 'data'),
      '--exec-root',
      join(directory, 'exec'),
      '--pidfile',
      pidFile,
      '--host',
      `unix://${socket}`,
      '--bridge',
      'none',
      '--iptables=false',
      '--ip6tables=false',
      '--storage-driver',
      'overlay2'
    ],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  let spawnError
  let exited = false
  child.on('error', (error) => {
    spawnError = error
  })
  child.stdin.on('error', () => {})
  child.stdout.on('error', () => {})
  child.stderr.on('error', () => {})
  child.stdout.resume()
  child.stderr.resume()
  const closed = new Promise((done) =>
    child.on('close', () => {
      exited = true
      done()
    })
  )
  const daemon = { name, socket, directory, sudoPid: child.pid }
  report.daemons.push(daemon)
  const docker = (args, label, options) =>
    run('docker', ['--host', `unix://${socket}`, ...args], `${name}-${label}`, options)
  const started = performance.now()
  let value
  const signalOwned = (pid, signal) => {
    if (!existsSync(`/proc/${pid}/cmdline`)) {
      return
    }
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    if (
      argv[argv.indexOf('--data-root') + 1] !== join(directory, 'data') ||
      argv[argv.indexOf('--host') + 1] !== `unix://${socket}`
    ) {
      throw new Error(`${name}: refusing to signal a PID without the private daemon identity.`)
    }
    run('sudo', ['-n', 'kill', `-${signal}`, String(pid)], `${name}-${signal.toLowerCase()}`, {
      allowFailure: true,
      timeoutMs: 5000
    })
  }
  try {
    let ready = false
    while (performance.now() - started < 30_000) {
      if (spawnError) {
        throw spawnError
      }
      if (exited) {
        throw new Error(`${name} dockerd exited before readiness.`)
      }
      if (
        existsSync(socket) &&
        docker(['info'], 'ready', { allowFailure: true, timeoutMs: 2000 }).code === 0
      ) {
        ready = true
        break
      }
      await delay(200)
    }
    if (!ready) {
      throw new Error(`${name} dockerd did not become ready.`)
    }
    daemon.pid = Number(readFileSync(pidFile, 'utf8').trim())
    daemon.startupMs = performance.now() - started
    if (!Number.isInteger(daemon.pid) || daemon.pid <= 1) {
      throw new Error('Invalid owned dockerd PID.')
    }
    if (docker(['image', 'ls', '--quiet'], 'empty').stdout.trim()) {
      throw new Error('Private daemon was not empty.')
    }
    value = await operation(docker)
  } finally {
    const pid =
      daemon.pid ?? (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : null)
    if (Number.isInteger(pid) && pid > 1) {
      signalOwned(pid, 'TERM')
      await Promise.race([closed, delay(10_000)])
      if (!exited) {
        signalOwned(pid, 'KILL')
        await Promise.race([closed, delay(2000)])
      }
    } else if (!exited) {
      child.kill('SIGTERM')
      await Promise.race([closed, delay(5000)])
    }
    daemon.stopped = exited
    save()
  }
  if (!exited) {
    throw new Error(`${name} owned dockerd did not stop; retaining scratch data.`)
  }
  return value
}

const inventorySource = `
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function entry(file) {
  const stat = fs.lstatSync(file);
  return { path: file, mode: stat.mode & 4095,
    ...(stat.isSymbolicLink() ? { type: 'link', target: fs.readlinkSync(file) } :
      stat.isDirectory() ? { type: 'directory' } : { type: 'file', bytes: stat.size, sha256: hash(file) }) };
}
function below(file) {
  const item = entry(file);
  return [item, ...(item.type === 'directory' ? fs.readdirSync(file).sort().flatMap(name => below(path.join(file, name))) : [])];
}
require('node-pty');
const addon = Object.keys(require.cache).find(file => file.endsWith('/pty.node'));
if (!addon) throw new Error('No loaded PTY addon');
const dependencies = JSON.parse(process.argv[1] || '[]').map(file => ({ ...entry(file), realpath: fs.realpathSync(file), sha256: hash(file) }));
console.log(JSON.stringify({ node: process.version, addon, payload: below('/usr/local'), dependencies }));
`

function dependencyPaths(text) {
  if (/not found/.test(text)) {
    throw new Error('Runtime ELF dependency was not found.')
  }
  return [
    ...new Set(
      text.split('\n').flatMap((line) => {
        const match = line.match(/=>\s+(\/\S+)/) ?? line.match(/^\s*(\/\S+)\s+\(/)
        return match ? [match[1]] : []
      })
    )
  ].sort()
}

function inventory(docker, image, name) {
  const first = JSON.parse(
    docker(
      [...containerRun, '--entrypoint', 'node', image, '-e', inventorySource],
      `${name}-payload`
    ).stdout
  )
  const libraries = docker(
    [...containerRun, '--entrypoint', 'ldd', image, '/usr/local/bin/node', first.addon],
    `${name}-ldd`
  ).stdout
  const paths = dependencyPaths(libraries)
  if (paths.length === 0) {
    throw new Error('Runtime dependency inventory was empty.')
  }
  const full = JSON.parse(
    docker(
      [
        ...containerRun,
        '--entrypoint',
        'node',
        image,
        '-e',
        inventorySource,
        '--',
        JSON.stringify(paths)
      ],
      `${name}-inventory`
    ).stdout
  )
  if (full.dependencies.length !== paths.length) {
    throw new Error('Runtime dependency byte inventory was incomplete.')
  }
  full.libraryPaths = paths
  writeFileSync(join(output, `${name}-inventory.json`), JSON.stringify(full, null, 2))
  return full
}

function assertRuntimeParity(baseline, candidate) {
  const removable = ['/usr/local/lib/python3.11', '/usr/local/lib/python3.11/dist-packages']
  const candidatePaths = new Set(candidate.payload.map((entry) => entry.path))
  const removed = baseline.payload.filter((entry) => !candidatePaths.has(entry.path))
  for (const entry of removed) {
    if (
      entry.type !== 'directory' ||
      !removable.includes(entry.path) ||
      baseline.payload.some(
        (child) =>
          child.path.startsWith(`${entry.path}/`) &&
          (child.type !== 'directory' || !removable.includes(child.path))
      )
    ) {
      throw new Error(
        `Runtime payload removal is not an empty Python build-tool directory: ${entry.path}`
      )
    }
  }
  const expected = {
    ...baseline,
    payload: baseline.payload.filter((entry) => !removed.includes(entry))
  }
  if (JSON.stringify(expected) !== JSON.stringify(candidate)) {
    throw new Error('Node, common payload bytes/modes/links or runtime dependencies changed.')
  }
  return removed.map((entry) => entry.path)
}

function comparatorControls(baseline, candidate) {
  const bytes = structuredClone(candidate)
  bytes.payload.find((entry) => entry.type === 'file').sha256 = 'deliberate-byte-change'
  const mode = structuredClone(candidate)
  mode.payload.find((entry) => entry.type === 'directory').mode ^= 8
  return Object.fromEntries(
    [
      ['byte-change', bytes],
      ['directory-mode-change', mode]
    ].map(([name, changed]) => {
      try {
        assertRuntimeParity(baseline, changed)
      } catch {
        return [name, 'rejected']
      }
      throw new Error(`Runtime comparator accepted ${name}.`)
    })
  )
}

function oracle(docker, image, label, leak = false) {
  const bundle = join(scratch, leak ? 'leak.cjs' : 'candidate.cjs')
  const result = docker(
    [
      'run',
      '--rm',
      '--network=none',
      '--platform',
      'linux/amd64',
      '-e',
      'ORCA_BACKGROUND_LAUNCH=1',
      '-v',
      `${bundle}:/fixtures/candidate.cjs:ro`,
      '-v',
      `${join(scratch, 'candidate.cjs')}:/fixtures/real.cjs:ro`,
      image,
      '/fixtures/candidate.cjs',
      'candidate'
    ],
    label,
    { allowFailure: leak, timeoutMs: 30_000 }
  )
  const observation = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .at(-1)
  if (
    !observation ||
    observation.mode !== 'candidate' ||
    observation.shutdownMs >= 5000 ||
    observation.canaryAfterDaemonExit !== 'live' ||
    observation.childAfterDaemonExit !== (leak ? 'live' : 'gone') ||
    result.code !== (leak ? 1 : 0)
  ) {
    throw new Error(
      `${label} did not establish the exact ${leak ? 'intentional leak' : 'shutdown'} result.`
    )
  }
  return { ms: result.ms, observation, code: result.code }
}

try {
  const context = join(root, 'config/docker/daemon-shutdown-descendants')
  const baselineFile = run(
    'git',
    ['show', `${base}:config/docker/daemon-shutdown-descendants/Dockerfile`],
    'baseline-source'
  ).stdout
  const candidateFile = readFileSync(join(context, 'Dockerfile'), 'utf8')
  report.sourceHead = run('git', ['rev-parse', 'HEAD'], 'source-head').stdout.trim()
  report.dockerfiles = { baseline: sha(baselineFile), candidate: sha(candidateFile) }
  report.context = Object.fromEntries(
    ['fixture.cjs', 'run-case.sh', 'bundle-entry.ts'].map((file) => [
      file,
      sha(readFileSync(join(context, file)))
    ])
  )
  if (baselineFile === candidateFile) {
    throw new Error('Baseline Dockerfile is identical to candidate; choose the pre-trim commit.')
  }
  const from = baselineFile.match(/^FROM (\S+)$/m)?.[1]
  if (!from || candidateFile.match(/^FROM (\S+)$/m)?.[1] !== from) {
    throw new Error('Base image policy changed.')
  }
  const bundled = await build({
    entryPoints: [join(context, 'bundle-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['node-pty'],
    outfile: join(scratch, 'candidate.cjs'),
    metafile: true,
    logLevel: 'warning'
  })
  writeFileSync(
    join(output, 'bundle-inputs.json'),
    JSON.stringify(
      Object.fromEntries(
        Object.keys(bundled.metafile.inputs)
          .sort()
          .map((file) => [file, sha(readFileSync(resolve(root, file)))])
      ),
      null,
      2
    )
  )
  writeFileSync(
    join(scratch, 'leak.cjs'),
    `const real = require('/fixtures/real.cjs'); module.exports = { ...real, TerminalHost: class extends real.TerminalHost { async dispose() {} } };\n`
  )
  report.bundleSha256 = sha(readFileSync(join(scratch, 'candidate.cjs')))
  {
    const docker = (args, label, options) => run('docker', args, `seed-${label}`, options)
    report.basePullMs = docker(['pull', '--platform', 'linux/amd64', from], 'pull').ms
    report.baseDigest = JSON.parse(
      docker(['image', 'inspect', from], 'base-inspect').stdout
    )[0].RepoDigests[0]
    const inventories = {}
    for (const [name, contents] of [
      ['baseline', baselineFile],
      ['candidate', candidateFile]
    ]) {
      const directory = join(scratch, `${name}-context`)
      cpSync(context, directory, { recursive: true })
      writeFileSync(
        join(directory, 'Dockerfile'),
        contents.replace(/^FROM \S+$/m, `FROM ${report.baseDigest}`)
      )
      const image = `orca-daemon-trim-${name}:pilot-${process.pid}`
      const buildResult = docker(
        [
          ...imageBuild,
          '--no-cache',
          '--build-arg',
          'BUILDKIT_INLINE_CACHE=1',
          '--tag',
          image,
          directory
        ],
        `${name}-cold-build`
      )
      inventories[name] = inventory(docker, image, name)
      docker(
        [
          ...containerRun,
          '--entrypoint',
          'dpkg-query',
          image,
          '-W',
          '-f=${binary:Package}\t${Version}\t${Installed-Size}\n'
        ],
        `${name}-packages`
      )
      if (name === 'candidate') {
        docker(
          [
            ...containerRun,
            '--entrypoint',
            '/bin/sh',
            image,
            '-ec',
            'for tool in gcc g++ make python3; do if command -v "$tool"; then exit 1; fi; done; test ! -d /root/.npm; test ! -d /root/.cache/node-gyp; command -v ps; command -v setsid; command -v timeout; command -v awk'
          ],
          'candidate-cleanup'
        )
      }
      const positive = oracle(docker, image, `${name}-positive`)
      const negative = oracle(docker, image, `${name}-leak`, true)
      const archiveDirectory = join(scratch, `${name}-archive`)
      mkdirSync(archiveDirectory)
      const archive = join(archiveDirectory, 'image.tar')
      const exportResult = docker(['save', '--output', archive, image], `${name}-save`)
      const compressed = join(scratch, `${name}.tzst`)
      const compression = run(
        'tar',
        [
          '--posix',
          '-cf',
          compressed,
          '--use-compress-program',
          'zstdmt',
          '-C',
          archiveDirectory,
          'image.tar'
        ],
        `${name}-compress`
      )
      const imageInfo = JSON.parse(
        docker(['image', 'inspect', image], `${name}-image-inspect`).stdout
      )[0]
      report.images[name] = {
        image,
        id: imageInfo.Id,
        imageBytes: imageInfo.Size,
        coldBuildMs: buildResult.ms,
        exportMs: exportResult.ms,
        compressionMs: compression.ms,
        archiveBytes: statSync(archive).size,
        compressedBytes: statSync(compressed).size,
        archiveSha256: sha(readFileSync(archive)),
        payloadSha256: sha(JSON.stringify(inventories[name].payload)),
        positive,
        negative
      }
      save()
    }
    report.allowedRemovedPaths = assertRuntimeParity(inventories.baseline, inventories.candidate)
    report.comparatorControls = comparatorControls(inventories.baseline, inventories.candidate)
    report.runtimeParity = true
  }
  for (let pair = 1; pair <= 3; pair++) {
    for (const name of pair % 2 === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
      await withDaemon(`pair-${pair}-${name}`, async (docker) => {
        const restored = join(scratch, `restore-${pair}-${name}`)
        mkdirSync(restored)
        const decompress = run(
          'tar',
          [
            '-xf',
            join(scratch, `${name}.tzst`),
            '--use-compress-program',
            'unzstd',
            '-C',
            restored
          ],
          `pair-${pair}-${name}-decompress`
        )
        const archive = join(restored, 'image.tar')
        if (sha(readFileSync(archive)) !== report.images[name].archiveSha256) {
          throw new Error('Restored archive changed.')
        }
        const loaded = docker(['load', '--input', archive], 'load')
        const image = report.images[name].image
        if (
          docker(
            ['image', 'inspect', '--format', '{{.Id}}', image],
            'loaded-identity'
          ).stdout.trim() !== report.images[name].id
        ) {
          throw new Error('Loaded image identity changed.')
        }
        const built = docker(
          [
            ...imageBuild,
            '--cache-from',
            image,
            '--tag',
            `${image}-consumer`,
            join(scratch, `${name}-context`)
          ],
          'consumer-build'
        )
        const buildLog = `${built.stdout}\n${built.stderr}`
        const runStep = buildLog.match(/^(#\d+) \[[^\]]+\] RUN /m)?.[1]
        if (!runStep || !new RegExp(`^${runStep} CACHED$`, 'm').test(buildLog)) {
          throw new Error('Restored provisioning RUN was not CACHED.')
        }
        const positive = oracle(docker, `${image}-consumer`, 'positive')
        report.samples.push({
          pair,
          treatment: name,
          decompressMs: decompress.ms,
          loadMs: loaded.ms,
          rebuildMs: built.ms,
          oracleMs: positive.ms,
          totalMs: decompress.ms + loaded.ms + built.ms + positive.ms,
          archiveBytes: report.images[name].archiveBytes,
          compressedBytes: report.images[name].compressedBytes,
          observation: positive.observation
        })
        rmSync(restored, { recursive: true, force: true })
        save()
      })
    }
  }
  report.limitations = [
    'Single default-network cold build per image in the existing hosted daemon after shared frozen base pull; no default daemon stop/prune.',
    'Seed and consumer FROM use the same resolved digest; production uses the mutable tag.',
    'Three alternating private-daemon restore pairs; filesystem page cache is not flushed.',
    'Cache-style zstd decompression and docker load include no GitHub cache network transfer.',
    'Private daemon startup and archive digest checks are outside consumer total; production daemon already runs.'
  ]
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
  report.medians = Object.fromEntries(
    ['baseline', 'candidate'].map((name) => [
      name,
      Object.fromEntries(
        ['decompressMs', 'loadMs', 'rebuildMs', 'oracleMs', 'totalMs'].map((field) => [
          field,
          median(
            report.samples
              .filter((sample) => sample.treatment === name)
              .map((sample) => sample[field])
          )
        ])
      )
    ])
  )
  report.status = 'passed'
  console.log(
    JSON.stringify({
      images: report.images,
      medians: report.medians,
      runtimeParity: report.runtimeParity
    })
  )
} catch (error) {
  report.status = 'failed'
  report.error = String(error.stack ?? error)
  throw error
} finally {
  save()
  if (report.daemons.every((daemon) => daemon.stopped)) {
    run('sudo', ['-n', 'rm', '-rf', '--', scratch], 'scratch-cleanup', {
      allowFailure: true,
      timeoutMs: 30_000
    })
  }
}
