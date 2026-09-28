import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = process.cwd()
const evidence = resolve(
  process.env.LOCALIZATION_PILOT_OUTPUT ?? '.tmp/ci-cache-benchmark/localization-hosted'
)
mkdirSync(evidence, { recursive: true })
const baselinePackage = realpathSync(join(root, 'node_modules/i18next-cli'))
const baselineDependencies = join(dirname(baselinePackage))
const baselineVersion = JSON.parse(readFileSync(join(baselinePackage, 'package.json'))).version
assert.equal(baselineVersion, '1.74.1')
const candidate = join(evidence, 'candidate')
mkdirSync(candidate, { recursive: true })
const packed = JSON.parse(
  execFileSync('npm', ['pack', 'i18next-cli@1.74.2', '--json', '--pack-destination', candidate], {
    encoding: 'utf8'
  })
)
execFileSync('tar', ['-xzf', join(candidate, packed[0].filename), '-C', candidate])
const candidatePackage = join(candidate, 'package')
symlinkSync(baselineDependencies, join(candidatePackage, 'node_modules'), 'dir')
const sortedPackage = join(evidence, 'baseline-sorted')
cpSync(baselinePackage, sortedPackage, {
  recursive: true,
  dereference: false,
  filter: (source) => source !== join(baselinePackage, 'node_modules')
})
symlinkSync(baselineDependencies, join(sortedPackage, 'node_modules'), 'dir')
const finderPath = join(sortedPackage, 'dist/esm/extractor/core/key-finder.js')
let finder = readFileSync(finderPath, 'utf8')
assert.ok(finder.includes('return await glob(config.extract.input, {'))
finder = finder.replace(
  'return await glob(config.extract.input, {',
  'const files = await glob(config.extract.input, {'
)
finder = finder.replace('nodir: true,\n    });', 'nodir: true,\n    });\n    return files.sort();')
assert.ok(finder.includes('return files.sort()'))
writeFileSync(finderPath, finder)
const { compareExtraction } = await import(
  pathToFileURL(join(root, 'config/scripts/verify-localization-extraction.mjs'))
)
const english = JSON.parse(readFileSync(join(root, 'src/renderer/src/i18n/locales/en.json')))
const knownDefaults = new Set([
  'auto.components.activity.ActivityPrototypePage.770d458144',
  'auto.components.automations.createDestination.stale',
  'auto.components.automations.createDestination.unavailable',
  'auto.components.linear.project.view.surfaces.7616c986c6',
  'auto.components.settings.RepositoryIconPicker.2b7d27b93c',
  'auto.components.settings.RepositoryPane.settingUpHost'
])
const results = []
const comparisons = []
const catalogs = new Map()
function flatten(value, prefix = '', output = {}) {
  for (const [key, child] of Object.entries(value)) {
    if (child !== null && typeof child === 'object') {
      flatten(child, `${prefix}${key}.`, output)
    } else {
      output[prefix + key] = child
    }
  }
  return output
}
function run(mode, pair, packagePath) {
  const directory = join(evidence, `${mode}-${pair}`)
  mkdirSync(directory, { recursive: true })
  const start = performance.now()
  const child = spawnSync(
    process.execPath,
    [
      join(packagePath, 'dist/esm/cli.js'),
      '--config',
      'config/i18next.config.ts',
      'extract',
      '--sync-primary',
      '--quiet'
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_I18N_EXTRACTION_OUTPUT: join(directory, '{{language}}.json')
      },
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024
    }
  )
  const seconds = (performance.now() - start) / 1000
  writeFileSync(join(directory, 'run.log'), child.stdout + child.stderr)
  assert.equal(child.status, 0, `${mode} extraction failed: ${child.stderr}`)
  const catalog = JSON.parse(readFileSync(join(directory, 'en.json')))
  const verdict = compareExtraction(catalog, english)
  assert.deepEqual(verdict.missingFromEnglish, [])
  assert.deepEqual(verdict.placeholderMismatches, [])
  catalogs.set(`${mode}-${pair}`, flatten(catalog))
  const require = createRequire(join(packagePath, 'package.json'))
  const result = {
    pair,
    mode,
    seconds,
    keys: verdict.extracted.size,
    swc: require('@swc/core/package.json').version,
    status: child.status
  }
  results.push(result)
  writeFileSync(join(evidence, 'results.json'), JSON.stringify(results, null, 2))
  console.log(`LOCALIZATION_MEASUREMENT ${JSON.stringify(result)}`)
}
for (let pair = 1; pair <= 3; pair++) {
  for (const mode of pair % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
    run(mode, pair, mode === 'baseline' ? baselinePackage : candidatePackage)
  }
  const before = catalogs.get(`baseline-${pair}`)
  const after = catalogs.get(`candidate-${pair}`)
  assert.deepEqual(Object.keys(before).sort(), Object.keys(after).sort())
  const differences = []
  for (const key of Object.keys(before)) {
    const placeholders = (value) =>
      [...value.matchAll(/\{\{[^}]+\}\}/g)].map((match) => match[0]).sort()
    assert.deepEqual(
      placeholders(before[key]),
      placeholders(after[key]),
      `placeholder difference ${key}`
    )
    if (before[key] !== after[key]) {
      assert.ok(knownDefaults.has(key), `unexpected default difference ${key}`)
      differences.push({ key, before: before[key], after: after[key] })
    }
  }
  comparisons.push({ pair, differences })
  writeFileSync(join(evidence, 'catalog-comparison.json'), JSON.stringify(comparisons, null, 2))
}
run('baseline-sorted', 1, sortedPackage)
assert.deepEqual(catalogs.get('baseline-sorted-1'), catalogs.get('candidate-1'))
console.log(
  'LOCALIZATION_PARITY exact keys and placeholders; exact defaults with equal sorted traversal'
)
