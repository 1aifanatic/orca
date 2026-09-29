import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SOURCE = '744846f844374847c902b5e7fd59b4342a51ef99'
export const PRODUCER = '34d1c11c67cbd1a653da1d07796daf7a1b0f2a7d'
export const PRODUCT = '2084c58ba5410106ce61153a9fb16cdb4b6e5301'
export const PATCH = '276f475c90c6761c58b9f56b3f4bfafa079d0c29c5861b23d2320c9ff39c35fb'
export const SUCCESS = 'Both patched Bun Windows targets built with network disabled. Native Windows behavior, signatures and production runtime promotion remain unqualified.'
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const json = file => JSON.parse(readFileSync(file, 'utf8'))

export function verifyProducer(run, runId) {
  assert.equal(String(run.id), String(runId))
  assert.equal(run.repository?.full_name, 'stablyai/orca')
  assert.equal(run.status, 'completed')
  assert.equal(run.conclusion, 'success')
  assert.equal(run.head_sha, PRODUCER)
  assert.equal(run.head_branch, 'OrcaWin/np-full-offline-bun-diagnostic')
  assert.equal(run.path, '.github/workflows/diagnostic-full-offline-bun.yml')
  assert.equal(run.event, 'push')
}

export function verifyStableBuildOptions(root) {
  const receipts = {}
  for (const arch of ['x64', 'aarch64']) {
    const argsPath = join(root, 'results', `${arch}-args.txt`)
    const args = readFileSync(argsPath, 'utf8').trim().split(/\r?\n/)
    assert.deepEqual(args, ['--profile=release', '--canary=false', '--os=windows',
      `--arch=${arch}`, '--lto=off', `--build-dir=build/conpty-${arch}`, '-j2',
      ...(arch === 'x64' ? ['--baseline=true'] : [])], 'Unexpected effective build arguments')
    const optionsPath = join(root, 'results', `${arch}-build-options.rs`)
    const options = readFileSync(optionsPath, 'utf8')
    for (const [name, declaration] of Object.entries({
      IS_CANARY: 'pub const IS_CANARY: bool = false;',
      SHA: `pub const SHA: &str = "${SOURCE}";`,
      BASE_PATH: 'pub const BASE_PATH: &[u8] = "/work/source".as_bytes();',
      CODEGEN_PATH: `pub const CODEGEN_PATH: &[u8] = "/work/source/build/conpty-${arch}/codegen".as_bytes();`
    })) {
      const matches = options.split(/\r?\n/).filter(line => line.includes(`pub const ${name}:`))
      assert.deepEqual(matches, [declaration], `Unexpected effective ${name}`)
    }
    assert.match(options, /pub const VERSION: crate::Version = crate::Version \{\r?\n    major: 1,\r?\n    minor: 4,\r?\n    patch: 2,\r?\n\};/)
    receipts[arch] = { argsSha256: digest(argsPath), optionsSha256: digest(optionsPath) }
  }
  return receipts
}

export function verifyOutput(root, productRoot, arch) {
  assert.ok(['x64', 'arm64'].includes(arch))
  assert.equal(readFileSync(join(root, 'results/SUCCESS'), 'utf8').trim(), SUCCESS)
  assert.equal(json(join(root, 'work/source-cache-receipt.json')).source, SOURCE)
  assert.equal(digest(join(root, 'results/applied.patch')), PATCH)
  const container = json(join(root, 'results/container.json'))
  assert.equal(container.length, 1)
  assert.equal(container[0].HostConfig.NetworkMode, 'none')
  assert.equal(container[0].HostConfig.NanoCpus, 2_000_000_000)
  assert.equal(container[0].HostConfig.Memory, 8 * 1024 ** 3)
  assert.equal(container[0].HostConfig.PidsLimit, 512)
  const buildOptions = verifyStableBuildOptions(root)
  const rows = readFileSync(join(root, 'results/output.sha256'), 'utf8').trim().split(/\r?\n/)
  assert.equal(rows.length, 2)
  const hashes = new Map()
  for (const row of rows) {
    const match = /^([a-f0-9]{64})  (bun-windows-(?:x64|aarch64)\.exe)$/.exec(row)
    assert.ok(match, 'Malformed output hash')
    assert.ok(!hashes.has(match[2]), 'Duplicate output hash')
    hashes.set(match[2], match[1])
  }
  const require = createRequire(join(productRoot, 'package.json'))
  const { readPeMachine, PE_MACHINE } = require('./config/scripts/windows-pe-machine.cjs')
  for (const [target, filename] of [['x64', 'bun-windows-x64.exe'], ['arm64', 'bun-windows-aarch64.exe']]) {
    const file = join(root, 'results', filename)
    assert.equal(digest(file), hashes.get(filename), 'Runtime digest mismatch')
    assert.equal(readPeMachine(file), PE_MACHINE[target], 'Runtime architecture mismatch')
  }
  const name = `bun-windows-${arch === 'arm64' ? 'aarch64' : arch}.exe`
  return { binary: resolve(root, 'results', name), sha256: hashes.get(name), architecture: arch, buildOptions }
}

export async function verifyPackage(candidate, productRoot) {
  assert.equal(digest(join(productRoot, 'out/orcad/bun-runtime.exe')), candidate.sha256,
    'Package substituted another runtime')
  const { WINDOWS_CONPTY_FILES } = await import(pathToFileURL(join(productRoot, 'src/shared/windows-conpty-release.ts')))
  const require = createRequire(join(productRoot, 'package.json'))
  const { readPeMachine, PE_MACHINE } = require('./config/scripts/windows-pe-machine.cjs')
  const companions = {}
  for (const [name, expected] of Object.entries(WINDOWS_CONPTY_FILES[candidate.architecture])) {
    const file = join(productRoot, 'out/orcad/conpty', name)
    assert.equal(digest(file), expected, 'ConPTY digest mismatch')
    assert.equal(readPeMachine(file), PE_MACHINE[candidate.architecture])
    companions[name] = expected
  }
  return { ...candidate, companions, conptyLibrary: resolve(productRoot, 'out/orcad/conpty/conpty.dll') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, receiptRoot, productRoot, arch, outputFile, runId] = process.argv.slice(2)
  verifyProducer(json(join(receiptRoot, 'producer-run.json')), runId)
  const candidate = verifyOutput(receiptRoot, resolve(productRoot), arch)
  const result = mode === 'package' ? await verifyPackage(candidate, resolve(productRoot)) : candidate
  assert.ok(mode === 'candidate' || mode === 'package')
  writeFileSync(outputFile, JSON.stringify({ producerRun: runId, producer: PRODUCER, source: SOURCE,
    product: PRODUCT, patch: PATCH, ...result }, null, 2) + '\n')
}
