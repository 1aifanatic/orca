// Reads a build's daemon protocol version and the older versions it can still attach to.
// Parsed from source text so a release tag and a candidate branch are read the same way.
// Usage: node daemon-protocol-facts.mjs <daemon-protocol-version.ts> <output.json>
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export function parseDaemonProtocolFacts(source) {
  const current = /export const PROTOCOL_VERSION = (\d+)\b/u.exec(source)
  const previous = /export const PREVIOUS_DAEMON_PROTOCOL_VERSIONS = \[([\d,\s]*)\]/u.exec(source)
  assert.ok(current && previous, 'daemon protocol declarations not found')
  const previousVersions = previous[1]
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number)
  assert.ok(previousVersions.every(Number.isSafeInteger), 'malformed previous protocol list')
  return { protocolVersion: Number(current[1]), previousProtocolVersions: previousVersions }
}

/** Whether `reader` can route sessions owned by a daemon speaking `owner`'s protocol. */
export function canAttach(reader, owner) {
  return (
    reader.protocolVersion === owner.protocolVersion ||
    reader.previousProtocolVersions.includes(owner.protocolVersion)
  )
}

/** What any candidate must declare for sessions to cross in each direction with `release`. */
export function crossingRequirements(release) {
  const accepted = [...release.previousProtocolVersions, release.protocolVersion]
  return {
    upgrade: `candidate speaks ${release.protocolVersion} or lists ${release.protocolVersion} as previous`,
    rollback: `candidate speaks one of ${Math.min(...accepted)}..${Math.max(...accepted)} (the release's own or previous list)`,
    // Only an owner the release already speaks can survive a rollback, so a newer-protocol candidate cannot.
    bothDirections: `candidate speaks ${release.protocolVersion}, or speaks an older release-listed version and lists ${release.protocolVersion} as previous`
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2)
  assert.ok(input && output, 'input and output paths required')
  const facts = parseDaemonProtocolFacts(readFileSync(input, 'utf8'))
  writeFileSync(output, `${JSON.stringify(facts)}\n`)
  console.log(JSON.stringify(facts))
}
