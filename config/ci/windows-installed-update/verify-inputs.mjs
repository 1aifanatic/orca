// Qualify-side admission of the two downloaded installers before anything is installed.
// Usage: node verify-inputs.mjs <input-A> <input-B> <arch> <source-sha> <summary.json>
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hashFile } from './installed-layout.mjs'

const [inputA, inputB, arch, source, output] = process.argv.slice(2)
assert.ok(inputA && inputB && arch && source && output, 'verify-inputs arguments required')
const { compareAppVersions } = await import(
  pathToFileURL(resolve('src/shared/app-version.ts')).href
)
const receipts = {}
for (const [label, directory] of [
  ['A', inputA],
  ['B', inputB]
]) {
  const receipt = JSON.parse(readFileSync(join(directory, 'build-receipt.json'), 'utf8'))
  assert.equal(receipt.label, label)
  assert.equal(receipt.arch, arch)
  assert.equal(receipt.source, source, `${label} was built from another source`)
  assert.equal(receipt.publish, 'never')
  assert.equal(await hashFile(join(directory, 'orca-windows-setup.exe')), receipt.installerSha256)
  receipts[label] = receipt
}
const { A, B } = receipts
assert.ok(compareAppVersions(B.version, A.version) > 0, 'B must be newer than A')
assert.equal(A.bunVersion, B.bunVersion, 'A/B must share the Bun API version')
assert.notEqual(A.bunSha256, B.bunSha256, 'A/B must bundle different Bun runtime bytes')
assert.equal(A.identity.daemonEntry, B.identity.daemonEntry, 'daemon entry must be identical')
assert.equal(B.admission?.sha256, await hashFile(join(inputB, 'admission.json')))
assert.equal(B.overlaySha256, await hashFile(join(inputB, 'overlay.json')))
writeFileSync(output, `${JSON.stringify({ arch, source, A, B }, null, 2)}\n`)
console.log(
  `Admitted A ${A.version} (Bun ${A.bunSha256.slice(0, 12)}) and B ${B.version} (Bun ${B.bunSha256.slice(0, 12)})`
)
