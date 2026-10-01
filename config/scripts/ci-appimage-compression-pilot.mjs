import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { linuxFormatArguments } from './package-linux-formats.mjs'
import { copyPrivateTree } from './space-sharing-copy.mjs'
import { describeProcessFailure, runProcessSync } from './script-child-process.mjs'

const require = createRequire(import.meta.url)
const { Arch } = require('builder-util')
const { getAppImageTools } = require('app-builder-lib/out/toolsets/linux.js')
const { verifyStaticAppImagePackage } = require('./static-appimage-package-contract.cjs')
const config = require('../electron-builder.config.cjs')
assert(process.platform === 'linux' && process.arch === 'x64', 'Use a Linux x64 pilot runner')
assert(process.env.GITHUB_ACTIONS === 'true', 'Use a disposable hosted pilot runner')
assert.equal(config.toolsets.appimage, '1.0.3', 'Compare the existing pinned toolset')
assert(!config.appImage?.compression || config.appImage.compression === 'zstd')
assert(!process.env.APPIMAGE_TOOLS_PATH, 'Start without a custom AppImage toolset')

const repository = resolve(import.meta.dirname, '../..')
const prepared = resolve(process.env.ORCA_PILOT_PREPARED_APP ?? 'dist/linux-unpacked')
assert.equal(readFileSync(join(prepared, 'resources/package-type'), 'utf8'), 'AppImage')
assert(
  statSync(join(prepared, 'resources/app.asar')).isFile(),
  'Prepare the full packaged app once'
)
assert(statSync(join(prepared, 'orca-ide')).isFile(), 'Include the real Linux Electron executable')
const directory = join(process.env.RUNNER_TEMP, 'appimage-compression-comparison')
const packages = join(process.env.RUNNER_TEMP, 'appimage-compression-packages')
mkdirSync(directory, { recursive: true })
mkdirSync(packages, { recursive: true })
const tools = await getAppImageTools('1.0.3', Arch.x64)
const runtime = readFileSync(tools.runtime)
const overlay = join(packages, 'zstd-level-3-tools')
mkdirSync(overlay)
symlinkSync(tools.desktopFileValidate, join(overlay, 'desktop-file-validate'))
symlinkSync(dirname(tools.runtime), join(overlay, 'runtimes'))
symlinkSync(dirname(tools.runtimeLibraries), join(overlay, 'lib'))
writeFileSync(
  join(overlay, 'mksquashfs'),
  '#!/usr/bin/env bash\nset -euo pipefail\nexec "$ORCA_PILOT_COMPRESSION_PROGRAM" "$@" -Xcompression-level 3\n',
  { mode: 0o755 }
)

function execute(program, args, options = {}) {
  const { env, log, ...processOptions } = options
  const result = runProcessSync({
    program,
    args,
    cwd: repository,
    timeoutMs: 10 * 60_000,
    maxOutputBytes: 16 * 1024 * 1024,
    ...processOptions,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ...env }
  })
  if (log) {
    writeFileSync(log, result.stdout + result.stderr)
  }
  assert.equal(result.code, 0, describeProcessFailure(result))
  assert(!result.timedOut && !result.outputTruncated, 'Require complete command output')
  return result.stdout
}

async function digestFile(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk)
  }
  return digest.digest('hex')
}

async function manifest(root) {
  const entries = []
  async function visit(directoryPath, prefix = '') {
    for (const name of readdirSync(directoryPath).sort()) {
      const path = join(directoryPath, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const stats = lstatSync(path)
      const entry = { path: relative, mode: stats.mode & 0o7777 }
      if (stats.isSymbolicLink()) {
        entries.push({ ...entry, type: 'link', target: readlinkSync(path) })
      } else if (stats.isDirectory()) {
        entries.push({ ...entry, type: 'directory' })
        await visit(path, relative)
      } else {
        assert(stats.isFile(), `Unexpected payload type: ${relative}`)
        entries.push({ ...entry, type: 'file', bytes: stats.size, sha256: await digestFile(path) })
      }
    }
  }
  await visit(root)
  return entries
}

function verifyRuntime(path, expectedLevel) {
  verifyStaticAppImagePackage(path, 'x64')
  const descriptor = openSync(path, 'r')
  try {
    const prefix = Buffer.alloc(runtime.length)
    assert.equal(readSync(descriptor, prefix, 0, prefix.length, 0), prefix.length)
    assert(prefix.equals(runtime), 'Preserve the exact pinned AppImage runtime bytes')
    // Confirm the override reached the artifact, rather than just its invocation.
    const squashfs = Buffer.alloc(106)
    assert.equal(
      readSync(descriptor, squashfs, 0, squashfs.length, runtime.length),
      squashfs.length
    )
    assert.equal(squashfs.readUInt32LE(0), 0x73717368)
    assert.equal(squashfs.readUInt16LE(20), 6, 'Preserve zstd compression')
    const hasOptions = (squashfs.readUInt16LE(24) & (1 << 10)) !== 0
    if (expectedLevel === 3) {
      assert(hasOptions, 'Require explicit level-3 compressor options')
      assert.equal(squashfs.readUInt16LE(96), 0x8004)
      assert.equal(squashfs.readInt32LE(98), 3)
    } else {
      assert(!hasOptions, 'Baseline must keep the pinned default level')
    }
  } finally {
    closeSync(descriptor)
  }
}

const sourceManifest = await manifest(prepared)
const rows = []
const firstImages = {}
let baselineManifest
const toolVersion = execute(tools.mksquashfs, ['-version'])
assert.match(
  toolVersion,
  /mksquashfs version 4\.6\.1/,
  'Require the existing default-level-15 tool'
)
writeFileSync(
  join(directory, 'environment.json'),
  JSON.stringify(
    {
      node: process.version,
      architecture: process.arch,
      image: process.env.ImageOS,
      imageVersion: process.env.ImageVersion,
      toolVersion,
      runtimeSha256: createHash('sha256').update(runtime).digest('hex'),
      sourceFiles: sourceManifest.filter((entry) => entry.type === 'file').length,
      sourceBytes: sourceManifest.reduce((total, entry) => total + (entry.bytes ?? 0), 0)
    },
    null,
    2
  )
)

for (let sample = 1; sample <= 3; sample++) {
  for (const variant of sample % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
    const runDirectory = join(packages, `${sample}-${variant}`)
    mkdirSync(runDirectory)
    const appDirectory = join(runDirectory, 'app')
    const outputDirectory = join(runDirectory, 'artifacts')
    const logPrefix = join(directory, `${sample}-${variant}`)
    const started = performance.now()
    copyPrivateTree(prepared, appDirectory, { unprotect: () => {} })
    const copyMs = performance.now() - started
    const env =
      variant === 'candidate'
        ? { APPIMAGE_TOOLS_PATH: overlay, ORCA_PILOT_COMPRESSION_PROGRAM: tools.mksquashfs }
        : {}
    execute(
      process.execPath,
      [
        require.resolve('electron-builder/cli.js'),
        ...linuxFormatArguments({ format: 'AppImage', appDirectory, outputDirectory }),
        '--config.appImage.compression=zstd'
      ],
      { env, log: `${logPrefix}-package.log` }
    )
    const packageMs = performance.now() - started
    const artifacts = readdirSync(outputDirectory).filter((name) => name.endsWith('.AppImage'))
    assert.equal(artifacts.length, 1)
    const artifact = join(outputDirectory, artifacts[0])
    const compressionLevel = variant === 'candidate' ? 3 : 15
    verifyRuntime(artifact, compressionLevel)
    const extractionDirectory = join(runDirectory, 'extracted')
    mkdirSync(extractionDirectory)
    const extractionStarted = performance.now()
    execute(artifact, ['--appimage-extract'], {
      cwd: extractionDirectory,
      log: `${logPrefix}-extract.log`
    })
    const extractionMs = performance.now() - extractionStarted
    const payload = await manifest(join(extractionDirectory, 'squashfs-root'))
    baselineManifest ??= payload
    assert.deepEqual(
      payload,
      baselineManifest,
      `${variant} changed extracted payload bytes, modes or links`
    )
    const result = {
      sample,
      variant,
      compressionLevel,
      copyMs: Math.round(copyMs),
      packageMs: Math.round(packageMs),
      extractionMs: Math.round(extractionMs),
      outputBytes: statSync(artifact).size,
      payloadSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      artifactSha256: await digestFile(artifact)
    }
    rows.push(result)
    writeFileSync(`${logPrefix}-manifest.json`, JSON.stringify(payload, null, 2))
    writeFileSync(join(directory, 'results.json'), JSON.stringify(rows, null, 2))
    console.log(JSON.stringify(result))
    rmSync(appDirectory, { recursive: true, force: true })
    rmSync(extractionDirectory, { recursive: true, force: true })
    if (!firstImages[variant]) {
      firstImages[variant] = artifact
    } else {
      rmSync(runDirectory, { recursive: true, force: true })
    }
  }
}

assert.deepEqual(await manifest(prepared), sourceManifest, 'The prepared input tree changed')
if (process.env.GITHUB_OUTPUT) {
  for (const [variant, path] of Object.entries(firstImages)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${variant}-appimage=${path}\n`)
  }
}
writeFileSync(
  join(directory, 'representative-artifacts.json'),
  JSON.stringify(firstImages, null, 2)
)
