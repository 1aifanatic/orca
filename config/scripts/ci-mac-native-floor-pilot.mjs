import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Mac native floor pilot requires macOS arm64')
}

const target = 'darwin-arm64'
const floor = [13, 5, 0]
const publishedBaseSha = '2c6c439f2270d153516a98a912731105113aa054'
const sourcePins = {
  '.github/actions/restore-pnpm-verification/action.yml':
    '4cda84b74eb8063262fb463d9289d2c9e19d00c2a89ccd4d559bcbeaad96085e',
  'pnpm-workspace.yaml': 'c6a151d1b5d2734bc6be54d48104a0aa6a18da0cd22e3e4799c99fd9665f7d04',
  'package.json': '33ce3cbb97500af0690cc32bd26e60db9fb7628692fbdeb7b99e98557aa966ff',
  'pnpm-lock.yaml': '3b50e687509eac4606bdc60cd890e4485862a4c5fcfca44317ac8802f5a849c1',
  'config/patches/node-pty@1.1.0.patch':
    '92c95cffab383d86b3b13a460c75a08074468ebf1f3911db8e874e083201f192',
  '.github/actions/install-node-dependencies/action.yml':
    '0fca9590b7e623f361baef85f5f88fe2e64be273bc5bca0de9d983c678d5148e',
  '.github/actions/prepare-orcad-prebuilds/action.yml':
    '30b5ff69c751a9ae550abf7b4817a683d50d4fc686a90fd9876f72d8ba865ac1',
  'config/scripts/build-orcad-prebuilds.mjs':
    '4e775590e9028c77844bdea5f3a879b5caac8ec3a7b959723e1083093deddd77',
  'config/scripts/orcad-prebuild-slot-contents.mjs':
    '48376c71a2b5da8c08e7ea8eb3a482bf9ba64ea154bd73d89f76765536bb5ce7',
  'config/scripts/orcad-prebuild-smoke.mjs':
    '2c51b24f8179dbbe0fece7f3f5826b52f10dbba49ca57cc7a4f59d629601cac0',
  'config/scripts/orcad-prebuild-smoke-child.cjs':
    '1100993473cfca7e5279c55162a9a8a15c634edacee4deddd434e10709e622f3',
  'config/scripts/build-orcad-node.mjs':
    'cf4b69f2551956318bc368112be9c5d254b8418994afad9ed9754bf8f480e32d',
  'config/scripts/build-orcad.mjs':
    '68eaae1ad1e6802f998aa2fbe919cdff11deb0ccdbc58d2140f0a198fe012de8',
  'config/scripts/orcad-watcher-package.mjs':
    'fc94f33ad589d013cc17fa6413e9dcd48cf37d5dbdaaf61da9af8b4d91a35a03',
  'config/scripts/pinned-node-downloads.mjs':
    'e24fe2324b9eb46f48f68e271daf485fa7d577c58a473d27ba4aa2b66f998687',
  'src/shared/node-runtime-pin.ts':
    'fcb1be2a87ee80eb7cd848ced1043d0986db43cb9183f82fe21d218f0e47406d',
  'src/shared/orcad-artifacts.ts':
    '16e0dd18797b4a08fbae9bd6f0a7f7e4e9a8dae863f180d48c0f8a1ea0f6315c'
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

function macMinimum(loadCommands, architectures) {
  assert.deepEqual(architectures.trim().split(/\s+/), ['arm64'], 'Expected only arm64')
  const commands = loadCommands
    .split(/^\s*Load command \d+\s*$/m)
    .filter((block) => /^\s*cmd LC_(?:BUILD_VERSION|VERSION_MIN_MACOSX)\s*$/m.test(block))
  assert.equal(commands.length, 1, 'Expected one macOS minimum load command')
  const command = commands[0]
  const modern = /^\s*cmd LC_BUILD_VERSION\s*$/m.test(command)
  if (modern) {
    assert.match(command, /^\s*platform (?:1|MACOS)\s*$/im, 'Expected macOS platform')
  }
  const raw = new RegExp(`^\\s*${modern ? 'minos' : 'version'} (\\S+)\\s*$`, 'm').exec(command)?.[1]
  assert.match(raw || '', /^\d+\.\d+(?:\.\d+)?$/, 'Missing or invalid macOS minimum')
  const version = raw.split('.').map(Number)
  while (version.length < 3) {
    version.push(0)
  }
  const differing = version.findIndex((part, index) => part !== floor[index])
  assert.ok(
    differing === -1 || version[differing] < floor[differing],
    `Minimum macOS ${raw} exceeds 13.5`
  )
  return { command: modern ? 'LC_BUILD_VERSION' : 'LC_VERSION_MIN_MACOSX', minimum: raw }
}

function parserControls() {
  const modern = (minimum, platform = '1') =>
    `Load command 0\n cmd LC_BUILD_VERSION\n platform ${platform}\n minos ${minimum}\n sdk 13.5\n`
  const legacy = 'Load command 0\n cmd LC_VERSION_MIN_MACOSX\n version 11.0\n sdk 15.4\n'
  assert.equal(macMinimum(modern('13.5'), 'arm64\n').minimum, '13.5')
  assert.equal(macMinimum(legacy, 'arm64').minimum, '11.0')
  const invalid = {
    'newer minimum despite older SDK': modern('15.0'),
    'newer patch minimum': modern('13.5.1'),
    'numeric minor comparison': modern('13.10'),
    'iOS platform': modern('13.0', '2'),
    'missing minimum command': 'Load command 0\n cmd LC_SEGMENT_64\n segname __TEXT\n',
    'missing minimum': 'Load command 0\n cmd LC_BUILD_VERSION\n platform 1\n sdk 13.5\n',
    'malformed minimum': modern('13.5garbage'),
    'conflicting minimum commands': modern('13.0') + legacy.replace('command 0', 'command 1')
  }
  for (const value of Object.values(invalid)) {
    assert.throws(() => macMinimum(value, 'arm64'))
  }
  for (const arch of ['x86_64', 'arm64 x86_64', '']) {
    assert.throws(() => macMinimum(modern('13.5'), arch))
  }
  return {
    passing: ['modern 13.5', 'legacy 11.0'],
    rejected: [...Object.keys(invalid), 'wrong, universal and missing architecture']
  }
}

const controls = parserControls()
if (process.argv.includes('--parser-controls')) {
  console.log(JSON.stringify(controls, null, 2))
  process.exit(0)
}

const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd())
const output = resolve(process.env.RUNNER_TEMP || import.meta.dirname, 'orca-mac-native-floor')
const fromWorkspace = (path) => import(pathToFileURL(join(workspace, path)).href)
const receipt = {
  qualified: false,
  publishedBaseSha,
  sourceSha: process.env.GITHUB_SHA || null,
  platform: process.platform,
  arch: process.arch,
  runnerImage: process.env.ImageVersion || null,
  hostNode: process.version,
  target,
  maximumMacMinimum: '13.5',
  parserControls: controls,
  sourceHashes: {},
  binaries: [],
  scope:
    'Mach-O architecture and deployment floor metadata, existing prebuild smoke and server build; no execution on macOS 13.5.'
}
await mkdir(output, { recursive: true })
try {
  assert.match(receipt.sourceSha || '', /^[a-f0-9]{40}$/, 'Missing exact checkout SHA')
  for (const [path, expected] of Object.entries(sourcePins)) {
    const actual = hash(await readFile(join(workspace, path)))
    receipt.sourceHashes[path] = actual
    assert.equal(actual, expected, `Published build input changed: ${path}`)
  }
  const { NODE_RUNTIME_PIN, NODE_RUNTIME_ASSETS } = await fromWorkspace(
    'src/shared/node-runtime-pin.ts'
  )
  const {
    ORCAD_NODE_PTY_DIR,
    ORCAD_PARCEL_WATCHER_NATIVE,
    ORCAD_NODE_RUNTIME_MARKER_FILENAME,
    ORCAD_SERVER_TARGET_FILENAME,
    orcadNodeRuntimeRelativePath,
    orcadNodePtySlotFiles
  } = await fromWorkspace('src/shared/orcad-artifacts.ts')
  const { findSlotProblems, readManifest, SLOT_NAPI_VERSION } = await fromWorkspace(
    'config/scripts/orcad-prebuild-slot-contents.mjs'
  )
  const { runProcessSync, describeProcessFailure } = await fromWorkspace(
    'config/scripts/script-child-process.mjs'
  )
  const { parseWatcherLockfile, watcherPackageIdentity } = await fromWorkspace(
    'config/scripts/orcad-watcher-package.mjs'
  )
  const require = createRequire(join(workspace, 'package.json'))
  const prebuilds = join(workspace, 'out/orcad-prebuilds')
  const packaged = join(workspace, 'out/orcad')
  const manifest = readManifest(prebuilds)
  receipt.manifest = manifest
  receipt.manifestSha256 = hash(await readFile(join(prebuilds, 'manifest.json')))
  assert.deepEqual(findSlotProblems(manifest, prebuilds, [target]), [])
  const files = orcadNodePtySlotFiles(target).sort()
  assert.deepEqual(Object.keys(manifest.slots).sort(), [target])
  assert.deepEqual(Object.keys(manifest.slots[target].files).sort(), files)
  assert.deepEqual((await readdir(join(prebuilds, target))).sort(), files)
  assert.equal(manifest.module, 'node-pty')
  assert.equal(manifest.version, require('node-pty/package.json').version)
  assert.equal(manifest.nodeHeaders, NODE_RUNTIME_PIN.version)
  assert.equal(manifest.napi, SLOT_NAPI_VERSION)
  assert.equal(manifest.slots[target].napi, SLOT_NAPI_VERSION)
  assert.equal(manifest.slots[target].platform, 'darwin')
  assert.equal(manifest.slots[target].arch, 'arm64')
  assert.equal(manifest.slots[target].libc, 'none')
  assert.equal(manifest.slots[target].glibc, null)
  const asset = NODE_RUNTIME_ASSETS[target]
  receipt.nodePin = { ...NODE_RUNTIME_PIN, asset }
  assert.equal(
    (await readFile(join(packaged, ORCAD_NODE_RUNTIME_MARKER_FILENAME), 'utf8')).trim(),
    asset.executableSha256
  )
  assert.equal(
    (await readFile(join(packaged, ORCAD_SERVER_TARGET_FILENAME), 'utf8')).trim(),
    target
  )
  const watcherVersion = require('@parcel/watcher/package.json').version
  receipt.watcherPin = {
    version: watcherVersion,
    ...watcherPackageIdentity(
      target,
      watcherVersion,
      parseWatcherLockfile(await readFile(join(workspace, 'pnpm-lock.yaml'), 'utf8'))
    )
  }
  function command(program, args) {
    const result = runProcessSync({
      program,
      args,
      cwd: workspace,
      timeoutMs: 10_000,
      maxOutputBytes: 512 * 1024
    })
    assert.ok(
      result.code === 0 && !result.timedOut && !result.outputTruncated,
      `${program}: ${describeProcessFailure(result)}`
    )
    return result.stdout
  }
  const paths = files.map((file) => join(prebuilds, target, file))
  paths.push(join(packaged, ORCAD_PARCEL_WATCHER_NATIVE))
  const node = join(packaged, ...orcadNodeRuntimeRelativePath(target, asset.executableSha256))
  paths.push(node)
  for (const path of paths) {
    const binary = await readFile(path)
    const details = await stat(path)
    const architectures = command('/usr/bin/lipo', ['-archs', path])
    const loadCommands = command('/usr/bin/otool', ['-l', path])
    const metadata = {
      path: relative(workspace, path),
      sha256: hash(binary),
      size: details.size,
      mode: details.mode & 0o777,
      architectures: architectures.trim(),
      ...macMinimum(loadCommands, architectures)
    }
    receipt.binaries.push(metadata)
    await writeFile(join(output, `${receipt.binaries.length}-load-commands.txt`), loadCommands)
    if (path === node) {
      assert.equal(metadata.sha256, asset.executableSha256)
      assert.equal(metadata.size, asset.executableSize)
      receipt.pinnedNodeVersion = command(node, ['--version']).trim()
      assert.equal(receipt.pinnedNodeVersion, `v${NODE_RUNTIME_PIN.version}`)
    } else if (files.includes(basename(path))) {
      const file = basename(path)
      assert.equal(metadata.sha256, manifest.slots[target].files[file])
      assert.equal(
        hash(await readFile(join(packaged, ORCAD_NODE_PTY_DIR, 'build/Release', file))),
        metadata.sha256
      )
    }
  }
  receipt.qualified = true
} catch (error) {
  receipt.error = error.stack || String(error)
  throw error
} finally {
  await writeFile(join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}
console.log(
  `mac-native-floor qualified: ${receipt.binaries.length} arm64 binaries, minimum macOS <=13.5`
)
