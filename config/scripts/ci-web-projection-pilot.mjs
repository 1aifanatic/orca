import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { describeProcessFailure, runProcessSync } from './script-child-process.mjs'

assert(process.env.GITHUB_ACTIONS === 'true', 'Use a disposable hosted pilot runner')
assert(process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP), 'Require RUNNER_TEMP')
const baseSha = process.env.BASE_SHA
assert.match(baseSha ?? '', /^[a-f0-9]{40}$/i, 'Require the original PR base commit in BASE_SHA')

const repository = resolve(import.meta.dirname, '../..')
const projectorRelative = 'config/scripts/project-renderer-web-client.mjs'
const projector = join(repository, projectorRelative)
const renderer = join(repository, 'out/renderer')
const web = join(repository, 'out/web')
const directory = join(process.env.RUNNER_TEMP, 'web-projection-comparison')
mkdirSync(directory, { recursive: true })
assert(lstatSync(join(renderer, '.vite/manifest.json')).isFile(), 'Build the renderer once first')
assert(lstatSync(projector).isFile(), 'Require the existing projector source file')
const candidateSource = readFileSync(projector)

function execute(program, args, log) {
  const started = performance.now()
  const result = runProcessSync({
    program,
    args,
    cwd: repository,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 5 * 60_000,
    maxOutputBytes: 16 * 1024 * 1024
  })
  const elapsedMs = performance.now() - started
  if (log) {
    writeFileSync(log, result.stdout + result.stderr)
  }
  assert.equal(result.code, 0, describeProcessFailure(result))
  assert(!result.timedOut && !result.outputTruncated, 'Require complete command output')
  return { stdout: result.stdout, elapsedMs }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function manifest(root) {
  const entries = []
  function visit(directoryPath, prefix = '') {
    for (const name of readdirSync(directoryPath).sort()) {
      const path = join(directoryPath, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const stats = lstatSync(path)
      const entry = { path: relative, mode: stats.mode & 0o7777 }
      if (stats.isSymbolicLink()) {
        entries.push({ ...entry, type: 'link', target: readlinkSync(path) })
      } else if (stats.isDirectory()) {
        entries.push({ ...entry, type: 'directory' })
        visit(path, relative)
      } else {
        assert(stats.isFile(), `Unexpected output type: ${relative}`)
        entries.push({
          ...entry,
          type: 'file',
          bytes: stats.size,
          sha256: digest(readFileSync(path))
        })
      }
    }
  }
  visit(root)
  return entries
}

function writeJson(name, value) {
  writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`)
}

const baselineSource = Buffer.from(
  execute('git', ['show', `${baseSha}:${projectorRelative}`]).stdout
)
assert(
  !candidateSource.equals(baselineSource),
  'Require different baseline and candidate projectors'
)
const rendererManifest = manifest(renderer)
const rendererSha256 = digest(JSON.stringify(rendererManifest))
writeJson('renderer-manifest.json', rendererManifest)
writeJson('environment.json', {
  baseSha,
  headSha: execute('git', ['rev-parse', 'HEAD']).stdout.trim(),
  baselineProjectorSha256: digest(baselineSource),
  candidateProjectorSha256: digest(candidateSource),
  node: process.version,
  executable: process.execPath,
  platform: process.platform,
  architecture: process.arch,
  image: process.env.ImageOS,
  imageVersion: process.env.ImageVersion,
  rendererSha256,
  rendererFiles: rendererManifest.filter((entry) => entry.type === 'file').length,
  rendererBytes: rendererManifest.reduce((total, entry) => total + (entry.bytes ?? 0), 0)
})

const rows = []
let baselineManifest
try {
  for (let sample = 1; sample <= 3; sample++) {
    for (const variant of sample % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
      writeFileSync(projector, variant === 'baseline' ? baselineSource : candidateSource)
      const { elapsedMs: projectionMs } = execute(
        process.execPath,
        [projector],
        join(directory, `${sample}-${variant}.log`)
      )

      // Hashing and parity checks stay outside the projector's measured time.
      const projected = manifest(web)
      writeJson(`${sample}-${variant}-manifest.json`, projected)
      baselineManifest ??= projected
      assert.deepEqual(
        projected,
        baselineManifest,
        `${sample}-${variant}: preserve every web output`
      )
      assert.equal(
        digest(JSON.stringify(manifest(renderer))),
        rendererSha256,
        `${sample}-${variant}: preserve the original renderer input`
      )
      const row = {
        sample,
        variant,
        projectionMs,
        files: projected.filter((entry) => entry.type === 'file').length,
        bytes: projected.reduce((total, entry) => total + (entry.bytes ?? 0), 0),
        webSha256: digest(JSON.stringify(projected)),
        rendererSha256,
        outputMatchesBaseline: true,
        rendererUnchanged: true
      }
      rows.push(row)
      writeJson('results.json', rows)
      console.log(JSON.stringify(row))
    }
  }
} finally {
  writeFileSync(projector, candidateSource)
}

function median(variant) {
  return rows
    .filter((row) => row.variant === variant)
    .map((row) => row.projectionMs)
    .sort((left, right) => left - right)[1]
}

const baselineMedianMs = median('baseline')
const candidateMedianMs = median('candidate')
const summary = {
  baselineMedianMs,
  candidateMedianMs,
  savedMedianMs: baselineMedianMs - candidateMedianMs,
  candidateToBaselineRatio: candidateMedianMs / baselineMedianMs,
  finalOutput: 'out/web',
  finalVariant: 'candidate',
  candidateProjectorRestored: readFileSync(projector).equals(candidateSource)
}
assert(summary.candidateProjectorRestored)
writeJson('summary.json', summary)
console.log(JSON.stringify(summary))
