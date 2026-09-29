// B-only overlay: pin the admitted candidate for both Windows targets and seed the build cache.
// Nothing else in the product source changes, so A and B differ only in Bun bytes and version.
// Usage: node apply-candidate-overlay.mjs <product-root> <admission.json> <overlay-receipt.json>
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [productRoot, admissionPath, output] = process.argv.slice(2)
assert.ok(productRoot && admissionPath && output, 'overlay arguments required')
const root = resolve(productRoot)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const admission = JSON.parse(readFileSync(admissionPath, 'utf8'))
const pinFile = join(root, 'src/shared/orcad-bun-runtime.ts')
const before = readFileSync(pinFile, 'utf8')
const { ORCAD_BUN_VERSION } = await import(pathToFileURL(pinFile).href)
const { orcadBunRuntimeFilename } = await import(
  pathToFileURL(join(root, 'src/shared/orcad-artifacts.ts')).href
)
assert.equal(admission.bunVersion, ORCAD_BUN_VERSION)

let after = before
const seeded = {}
for (const arch of ['x64', 'arm64']) {
  const target = `win32-${arch}`
  const { binary, sha256: candidate, productionSha256 } = admission.targets[arch]
  assert.equal(sha256(readFileSync(binary)), candidate, `${arch} candidate changed after admission`)
  const pin = `executableSha256: '${productionSha256}'`
  assert.equal(after.split(pin).length, 2, `${target} production pin must appear exactly once`)
  after = after.replace(pin, `executableSha256: '${candidate}'`)
  const cache = join(root, 'out', '.orcad-bun-runtime', `v${ORCAD_BUN_VERSION}`, target)
  mkdirSync(cache, { recursive: true })
  const destination = join(cache, orcadBunRuntimeFilename(target))
  copyFileSync(binary, destination)
  assert.equal(sha256(readFileSync(destination)), candidate)
  seeded[arch] = candidate
}
writeFileSync(pinFile, after)
const receipt = {
  changedPaths: ['src/shared/orcad-bun-runtime.ts'],
  pinFileBeforeSha256: sha256(before),
  pinFileAfterSha256: sha256(after),
  admissionSha256: sha256(readFileSync(admissionPath)),
  seededExecutables: seeded
}
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify(receipt))
