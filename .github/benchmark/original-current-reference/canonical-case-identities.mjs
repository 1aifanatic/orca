import assert from 'node:assert/strict'

export function canonicalCases(raw, files) {
  const generatedFile = 'src/main/ai-vault/session-scanner-opencode-native-worker.test.ts'
  const prefix = 'reads native signals and paginated history from '
  const generated = raw.filter(test => test.file === generatedFile && test.title.startsWith(prefix))
  assert.equal(generated.length, files.includes(generatedFile) ? 2 : 0, 'Only the two original database-path table cases may vary')
  const suffixes = new Set()
  const normalized = raw.map(test => {
    if (!generated.includes(test)) return test
    assert.deepStrictEqual(test.ancestorTitles, ['OpenCode reads through the production shared worker'])
    const match = test.title.match(/^(reads native signals and paginated history from .*[\\/])orca-opencode-native-worker-[A-Za-z0-9]+([\\/](?:v1[\\/]opencode\.db|v2\.db))$/)
    assert.ok(match, 'Generated path is outside the two source-qualified database variants')
    assert.equal(test.fullName, `${test.ancestorTitles.join(' ')} ${test.title}`, 'Unexpected generated-title ancestry')
    suffixes.add(match[2].replaceAll('\\', '/'))
    const title = `${match[1]}orca-opencode-native-worker-<generated>${match[2]}`
    return { ...test, title, fullName: `${test.ancestorTitles.join(' ')} ${title}` }
  })
  if (generated.length) assert.deepStrictEqual([...suffixes].sort(), ['/v1/opencode.db', '/v2.db'])
  const normalizedGenerated = normalized.filter(test => test.file === generatedFile && test.title.startsWith(prefix))
  assert.equal(new Set(normalizedGenerated.map(test => test.fullName)).size, generated.length, 'Never collapse distinct database variants')
  const nonceFile = 'src/shared/orcad-profile-preflight.test.ts'
  const noncePrefix = 'refuses stale or incomplete evidence: '
  const table = raw.filter(test => test.file === nonceFile && test.title.startsWith(noncePrefix))
  assert.equal(table.length, files.includes(nonceFile) ? 6 : 0, 'Keep all six original readiness table variants')
  const nonces = table.filter(test => test.title.startsWith(`${noncePrefix}{"nonce"`))
  assert.equal(nonces.length, files.includes(nonceFile) ? 1 : 0, 'Only the one source-qualified stale-nonce case may vary')
  if (table.length) {
    assert.deepStrictEqual(table.filter(test => !nonces.includes(test)).map(test => test.title).sort(), [
      '{"runtime":"node"}', '{"runtimeVersion":"1.4.0"}', '{"artifactVersion":"0.1.0+000000000000"}', '{"revision":0}', '{"sqliteVersion":""}'
    ].map(value => noncePrefix + value).sort(), 'Never normalize any other readiness table input')
    for (const test of table) {
      assert.deepStrictEqual(test.ancestorTitles, ['candidate profile readiness'])
      assert.equal(test.fullName, `${test.ancestorTitles.join(' ')} ${test.title}`)
    }
  }
  const canonical = normalized.map(test => {
    if (!nonces.includes(test)) return test
    assert.match(test.title, /^refuses stale or incomplete evidence: \{"nonce":"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"\}$/, 'Require the exact sole-key nonce UUIDv4 source shape')
    const title = `${noncePrefix}{"nonce":"<generated-uuid-v4>"}`
    return { ...test, title, fullName: `${test.ancestorTitles.join(' ')} ${title}` }
  })
  const names = canonical.filter(test => test.file === nonceFile).map(test => test.fullName)
  assert.equal(new Set(names).size, names.length, 'Never collapse readiness case identities')
  return canonical
}
