// Receipts one unsigned diagnostic installer after electron-builder; never publishes.
// Usage: node receipt-package.mjs --label A|B --arch x64|arm64 --version <v> --source <sha>
//   --dist <dir> --output <dir> [--admission <file> --overlay <file>]
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  hashFile,
  hashIdentity,
  packagedBunManifest,
  packagedVersion
} from './installed-layout.mjs'

const options = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  options.set(process.argv[index].replace(/^--/u, ''), process.argv[index + 1])
}
const required = (name) => {
  const value = options.get(name)
  assert.ok(value, `--${name} is required`)
  return value
}
const label = required('label')
const arch = required('arch')
const version = required('version')
const dist = resolve(required('dist'))
const output = resolve(required('output'))
assert.ok(['A', 'B'].includes(label) && ['x64', 'arm64'].includes(arch))

const installer = join(dist, 'orca-windows-setup.exe')
const unpacked = join(dist, arch === 'x64' ? 'win-unpacked' : 'win-arm64-unpacked')
assert.ok(existsSync(installer) && existsSync(unpacked), 'installer and unpacked app required')
const { ORCAD_BUN_RELEASE_ASSETS, ORCAD_BUN_VERSION } = await import(
  pathToFileURL(resolve('src/shared/orcad-bun-runtime.ts')).href
)
let expectedBun = ORCAD_BUN_RELEASE_ASSETS[`win32-${arch}`].executableSha256
let admission = null
if (label === 'B') {
  const admissionPath = required('admission')
  admission = JSON.parse(readFileSync(admissionPath, 'utf8'))
  assert.equal(
    expectedBun,
    admission.targets[arch].sha256,
    'B source is not pinned to the candidate'
  )
  assert.notEqual(expectedBun, admission.targets[arch].productionSha256)
  admission = { sha256: await hashFile(admissionPath), producerRun: admission.producerRun }
}
const identity = await hashIdentity(unpacked)
const manifest = packagedBunManifest(unpacked)
assert.equal(identity.bunRuntime, expectedBun, 'packaged Bun is not the expected generation')
assert.deepEqual(manifest, {
  target: `win32-${arch}`,
  version: ORCAD_BUN_VERSION,
  sha256: expectedBun
})
assert.equal(packagedVersion(unpacked), version, 'packaged app version mismatch')

mkdirSync(output, { recursive: true })
copyFileSync(installer, join(output, 'orca-windows-setup.exe'))
if (label === 'B') {
  copyFileSync(required('admission'), join(output, 'admission.json'))
  copyFileSync(required('overlay'), join(output, 'overlay.json'))
}
const receipt = {
  label,
  arch,
  version,
  source: required('source'),
  bunVersion: ORCAD_BUN_VERSION,
  bunSha256: expectedBun,
  admission,
  overlaySha256: label === 'B' ? await hashFile(required('overlay')) : null,
  installerSha256: await hashFile(installer),
  installerBytes: statSync(installer).size,
  identity,
  signed: false,
  publish: 'never'
}
writeFileSync(join(output, 'build-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify({ label, arch, version, bunSha256: expectedBun }))
