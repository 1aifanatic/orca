// Admits the patched stable Bun candidate with the SSH diagnostic's pinned verifier, unmodified.
// Usage: node admit-candidate.mjs <ssh-tools-dir> <producer-dir> <product-root> <run-id> <receipt.json>
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [tools, producer, productRoot, runId, output] = process.argv.slice(2)
assert.ok(tools && producer && productRoot && runId && output, 'admission arguments required')
const verifier = await import(pathToFileURL(resolve(tools, 'verify-bun-output.mjs')).href)
const { ORCAD_BUN_RELEASE_ASSETS, ORCAD_BUN_VERSION } = await import(
  pathToFileURL(resolve(productRoot, 'src/shared/orcad-bun-runtime.ts')).href
)

verifier.verifyProducer(
  JSON.parse(readFileSync(join(producer, 'producer-run.json'), 'utf8')),
  runId
)
const targets = {}
for (const arch of ['x64', 'arm64']) {
  const candidate = verifier.verifyOutput(resolve(producer), resolve(productRoot), arch)
  const production = ORCAD_BUN_RELEASE_ASSETS[`win32-${arch}`].executableSha256
  // Same Bun version, different bytes: that is what makes B a distinct runtime generation.
  assert.notEqual(candidate.sha256, production, `candidate ${arch} equals the production pin`)
  targets[arch] = {
    binary: candidate.binary,
    sha256: candidate.sha256,
    productionSha256: production
  }
}
const receipt = {
  producerRun: String(runId),
  producer: verifier.PRODUCER,
  source: verifier.SOURCE,
  patch: verifier.PATCH,
  bunVersion: ORCAD_BUN_VERSION,
  verifierSha256: createHash('sha256')
    .update(readFileSync(resolve(tools, 'verify-bun-output.mjs')))
    .digest('hex'),
  targets
}
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify({ admitted: Object.keys(targets), producerRun: receipt.producerRun }))
