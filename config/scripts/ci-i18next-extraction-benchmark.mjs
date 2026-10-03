import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { compareExtraction } from './verify-localization-extraction.mjs'

const exec = promisify(execFile)
const english = JSON.parse(await fs.readFile('src/renderer/src/i18n/locales/en.json', 'utf8'))
const records = []
const versions = { before: '.orca-i18next-before', after: 'i18next-cli' }
const catalogs = {}
for (const [index, order] of [
  ['before', 'after'],
  ['after', 'before'],
  ['before', 'after'],
  ['after', 'before']
].entries()) {
  for (const version of order) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-i18next-bench-'))
    try {
      const start = performance.now()
      await exec(
        process.execPath,
        [
          path.join('node_modules', versions[version], 'dist/esm/cli.js'),
          '--config',
          'config/i18next.config.ts',
          'extract',
          '--sync-primary',
          '--quiet'
        ],
        {
          env: { ...process.env, ORCA_I18N_EXTRACTION_OUTPUT: path.join(dir, '{{language}}.json') },
          maxBuffer: 16 * 1024 * 1024
        }
      )
      const extracted = JSON.parse(await fs.readFile(path.join(dir, 'en.json'), 'utf8'))
      const result = compareExtraction(extracted, english)
      const seconds = (performance.now() - start) / 1000
      const entries = [...result.extracted.entries()].sort(([a], [b]) => a.localeCompare(b))
      catalogs[version] = Object.fromEntries(entries)
      const record = {
        version,
        sample: index,
        warmup: index === 0,
        seconds,
        keys: result.extracted.size,
        hash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
        missing: result.missingFromEnglish,
        placeholderMismatches: result.placeholderMismatches
      }
      records.push(record)
      console.log(JSON.stringify(record))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
}
const median = (version) =>
  records
    .filter((r) => r.version === version && !r.warmup)
    .map((r) => r.seconds)
    .sort((a, b) => a - b)[1]
const before = median('before')
const after = median('after')
const keys = new Set([...Object.keys(catalogs.before), ...Object.keys(catalogs.after)])
const changes = [...keys]
  .filter((key) => catalogs.before[key] !== catalogs.after[key])
  .map((key) => ({ key, before: catalogs.before[key], after: catalogs.after[key] }))
const summary = { before, after, improvementPercent: (100 * (before - after)) / before, changes }
await fs.writeFile(
  'i18next-extraction-comparison.json',
  JSON.stringify({ records, summary }, null, 2)
)
console.log(JSON.stringify(summary))
await fs.appendFile(
  process.env.GITHUB_STEP_SUMMARY,
  `Before median: ${before.toFixed(2)}s; after median: ${after.toFixed(2)}s; improvement: ${summary.improvementPercent.toFixed(1)}%; catalog changes: ${changes.length}\n`
)
if (records.some((r) => r.missing.length || r.placeholderMismatches.length)) {
  process.exitCode = 1
}
for (const version of Object.keys(versions)) {
  if (new Set(records.filter((r) => r.version === version).map((r) => r.hash)).size !== 1) {
    process.exitCode = 1
  }
}
