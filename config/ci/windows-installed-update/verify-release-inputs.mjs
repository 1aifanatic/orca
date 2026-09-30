// Qualify-side admission of the release and candidate installers before anything is installed.
// Usage: node verify-release-inputs.mjs <release-dir> <candidate-dir> <release-sha256> <candidate-source> <summary.json>
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canAttach, crossingRequirements } from './daemon-protocol-facts.mjs'
import { hashFile } from './installed-layout.mjs'

const [releaseDir, candidateDir, releaseSha256, candidateSource, output] = process.argv.slice(2)
assert.ok(
  releaseDir && candidateDir && releaseSha256 && candidateSource && output,
  'arguments required'
)
const { compareAppVersions } = await import(
  pathToFileURL(resolve('src/shared/app-version.ts')).href
)
const release = JSON.parse(readFileSync(join(releaseDir, 'release-receipt.json'), 'utf8'))
const candidate = JSON.parse(readFileSync(join(candidateDir, 'build-receipt.json'), 'utf8'))
const candidateProtocol = JSON.parse(
  readFileSync(join(candidateDir, 'daemon-protocol.json'), 'utf8')
)
assert.equal(release.sha256, releaseSha256, 'release receipt is not the pinned installer')
assert.equal(await hashFile(join(releaseDir, 'orca-windows-setup.exe')), releaseSha256)
assert.equal(release.signer.status, 'Valid')
assert.equal(candidate.source, candidateSource, 'candidate was built from another source')
assert.equal(candidate.publish, 'never')
assert.equal(
  await hashFile(join(candidateDir, 'orca-windows-setup.exe')),
  candidate.installerSha256
)
assert.ok(
  compareAppVersions(candidate.version, release.version) > 0,
  'candidate must be newer than the release'
)
const summary = {
  release,
  candidate,
  candidateProtocol,
  candidateReachesReleaseOwned: canAttach(candidateProtocol, release.daemonProtocol),
  releaseReachesCandidateOwned: canAttach(release.daemonProtocol, candidateProtocol),
  crossingRequirements: crossingRequirements(release.daemonProtocol)
}
writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`)
console.log(
  `Admitted release ${release.version} (protocol ${release.daemonProtocol.protocolVersion}) and candidate ${candidate.version} (protocol ${candidateProtocol.protocolVersion}); design attach release->candidate=${summary.candidateReachesReleaseOwned}, rollback=${summary.releaseReachesCandidateOwned}`
)
