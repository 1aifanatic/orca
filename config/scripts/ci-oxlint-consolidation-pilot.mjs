import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript-api'
import { resolveOxlintInvocation } from './oxlint-cli-invocation.mjs'
import { describeProcessFailure, runProcessSync, spawnProcess } from './script-child-process.mjs'

const repository = resolve(import.meta.dirname, '../..')
const directory = join(process.env.RUNNER_TEMP ?? tmpdir(), 'oxlint-consolidation-pilot')
const temporaryConfig = join(repository, '.orca-oxlint-consolidation-pilot.json')
const cli = resolveOxlintInvocation(repository)
const threads = 4
if (process.env.ORCA_OXLINT_PILOT_ALLOW_LOCAL !== '1') {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use a disposable hosted pilot runner')
  assert.equal(process.arch, 'arm64', 'Compare on the existing ARM runner')
  assert.equal(availableParallelism(), threads, 'Compare on a four-CPU runner')
}
assert(!existsSync(temporaryConfig), 'Refuse to overwrite an existing pilot configuration')
mkdirSync(directory, { recursive: true })

const configurationPaths = {
  root: '.oxlintrc.json',
  anti: 'config/oxlint-anti-slop.json',
  native: 'config/oxlint-code-quality-native-plugins.json',
  typed: 'config/oxlint-code-quality-type-aware.json',
  mobile: 'mobile/.oxlintrc.json'
}
const commands = {
  root: [],
  anti: [
    '--config',
    configurationPaths.anti,
    'src',
    'config',
    'tests',
    'mobile',
    '--deny-warnings'
  ],
  native: [
    '--config',
    configurationPaths.native,
    'src',
    'config',
    'tests',
    'mobile',
    '--deny-warnings'
  ],
  typed: [
    '--type-aware',
    '--config',
    configurationPaths.typed,
    'src',
    'config',
    'tests',
    '--deny-warnings'
  ],
  merged: ['--config', temporaryConfig, '--disable-nested-config']
}
const scope = ['src/**', 'config/**', 'tests/**', 'mobile/**']
const offCategories = Object.fromEntries(
  ['correctness', 'suspicious', 'pedantic', 'perf', 'style', 'restriction', 'nursery'].map(
    (name) => [name, 'off']
  )
)

function loadConfigurations() {
  return Object.fromEntries(
    Object.entries(configurationPaths).map(([name, path]) => {
      const contents = readFileSync(join(repository, path), 'utf8')
      const parsed = ts.parseConfigFileTextToJson(path, contents)
      assert(!parsed.error, ts.flattenDiagnosticMessageText(parsed.error?.messageText ?? '', '\n'))
      return [name, parsed.config]
    })
  )
}

function synchronousCommand(program, args, cwd = repository) {
  const result = runProcessSync({
    program,
    args,
    cwd,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 60_000,
    maxOutputBytes: 16 * 1024 * 1024
  })
  assert.equal(result.code, 0, describeProcessFailure(result))
  assert(!result.timedOut && !result.outputTruncated, 'Require complete command output')
  return result.stdout
}

function expandedRootConfiguration() {
  return JSON.parse(synchronousCommand(cli.command, [...cli.prefixArgs, '--print-config']))
}

function normalizeExpandedRule(value) {
  const severity = { deny: 'error', allow: 'off', warn: 'warn' }
  return Array.isArray(value)
    ? [severity[value[0]] ?? value[0], ...value[1]]
    : (severity[value] ?? value)
}

function failAuditWarnings(rules) {
  return Object.fromEntries(
    Object.entries(rules ?? {}).map(([name, value]) => [
      name,
      Array.isArray(value)
        ? [value[0] === 'warn' ? 'error' : value[0], ...value.slice(1)]
        : value === 'warn'
          ? 'error'
          : value
    ])
  )
}

function prefixedGlob(pattern, prefix = '') {
  return pattern.startsWith('**') ? pattern : join(prefix, pattern).replaceAll('\\', '/')
}

function ignoredFileGlobs(patterns, prefix = '') {
  return patterns.flatMap((pattern) => {
    const glob = prefixedGlob(pattern, prefix)
    return glob.endsWith('/**') ? [glob] : [glob, `${glob}/**`]
  })
}

function mergedConfiguration(configurations, expanded) {
  const { root, anti, native, mobile } = configurations
  assert.deepEqual(
    mobile.extends,
    ['../.oxlintrc.json'],
    'Preserve the existing nested mobile base'
  )
  const rootRules = {
    ...Object.fromEntries(
      Object.entries(expanded.rules).map(([name, value]) => [name, normalizeExpandedRule(value)])
    ),
    // --print-config omits top-level JS rules; the source config remains authoritative.
    ...root.rules
  }
  const rootRuleNames = new Set([
    ...Object.keys(rootRules),
    ...root.overrides.flatMap((override) => Object.keys(override.rules))
  ])
  const rootExcludedInsideAudits = root.ignorePatterns.filter((pattern) =>
    scope.some((tree) => pattern.startsWith(tree.slice(0, -2)))
  )
  const auditRuleNames = new Set(
    [anti, native].flatMap((config) => [
      ...Object.keys(config.rules),
      ...config.overrides.flatMap((override) => Object.keys(override.rules))
    ])
  )
  const outsideAuditRules = Object.fromEntries(
    [...auditRuleNames].map((name) => [name, rootRules[name] ?? 'off'])
  )
  function auditOverrides(config, name) {
    const ignored = ignoredFileGlobs(config.ignorePatterns, 'config')
    const rules = name === 'native' ? failAuditWarnings(config.rules) : config.rules
    return [
      { files: scope, excludeFiles: ignored, rules },
      ...config.overrides.map((override) => ({
        ...override,
        files: override.files.map((pattern) => prefixedGlob(pattern, 'config')),
        excludeFiles: [
          ...ignored,
          ...(override.excludeFiles ?? []).map((pattern) => prefixedGlob(pattern, 'config'))
        ],
        rules: name === 'native' ? failAuditWarnings(override.rules) : override.rules
      }))
    ]
  }
  const jsPlugins = [
    ...root.jsPlugins.map((plugin) => ({
      ...plugin,
      specifier: resolve(repository, plugin.specifier)
    })),
    ...anti.jsPlugins.map((plugin) => ({
      ...plugin,
      specifier: resolve(repository, 'config', plugin.specifier)
    }))
  ]
  return {
    ...root,
    plugins: [...new Set([...root.plugins, ...native.plugins])],
    jsPlugins,
    categories: offCategories,
    rules: rootRules,
    overrides: [
      ...root.overrides,
      { files: ['mobile/**'], rules: mobile.rules },
      ...mobile.overrides.map((override) => ({
        ...override,
        files: override.files.map((pattern) => prefixedGlob(pattern, 'mobile'))
      })),
      {
        files: ignoredFileGlobs(rootExcludedInsideAudits),
        rules: Object.fromEntries([...rootRuleNames].map((name) => [name, 'off']))
      },
      ...auditOverrides(anti, 'anti'),
      ...auditOverrides(native, 'native'),
      { files: ['**'], excludeFiles: scope, rules: outsideAuditRules }
    ],
    ignorePatterns: [
      ...root.ignorePatterns.filter((pattern) => !rootExcludedInsideAudits.includes(pattern)),
      ...mobile.ignorePatterns.map((pattern) => prefixedGlob(pattern, 'mobile'))
    ]
  }
}

async function invocation(label, args, cwd = repository) {
  const output = join(directory, `${label}.stdout`)
  const errors = join(directory, `${label}.stderr`)
  const stdout = openSync(output, 'w')
  const stderr = openSync(errors, 'w')
  const startedAt = new Date().toISOString()
  const start = performance.now()
  let timedOut = false
  try {
    const child = spawnProcess({
      program: cli.command,
      args: [...cli.prefixArgs, ...args, `--threads=${threads}`],
      cwd,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      stdio: ['ignore', stdout, stderr]
    })
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, 10 * 60_000)
    let code
    try {
      code = await new Promise((resolveExit, reject) => {
        child.once('error', reject)
        child.once('exit', resolveExit)
      })
    } finally {
      clearTimeout(timeout)
    }
    assert(!timedOut, `${label} exceeded the pilot deadline`)
    return { label, args, startedAt, code, elapsedMs: performance.now() - start, output, errors }
  } finally {
    closeSync(stdout)
    closeSync(stderr)
  }
}

async function lint(label, name, cwd = repository, path) {
  const args =
    name === 'merged' && cwd !== repository
      ? ['--config', 'merged-config.json', '--disable-nested-config']
      : commands[name]
  const result = await invocation(
    label,
    [...args, '--format', 'json', ...(path ? [path] : [])],
    cwd
  )
  return { ...result, report: JSON.parse(readFileSync(result.output, 'utf8')) }
}

async function fileInventory(name) {
  const result = await invocation(`inventory-${name}`, [...commands[name], '--debug', 'files'])
  assert.equal(result.code, 0, readFileSync(result.output, 'utf8'))
  return new Set(readFileSync(result.output, 'utf8').trim().split('\n').filter(Boolean))
}

function diagnosticUnion(gates) {
  const union = new Map()
  for (const [name, result] of Object.entries(gates)) {
    for (const diagnostic of result.report.diagnostics) {
      const key = JSON.stringify([
        diagnostic.filename,
        diagnostic.code,
        diagnostic.message,
        diagnostic.labels
      ])
      const severity =
        name !== 'root' && diagnostic.severity === 'warning' ? 'error' : diagnostic.severity
      union.set(key, severity === 'error' || union.get(key) === 'error' ? 'error' : severity)
    }
  }
  return [...union].sort(([left], [right]) => left.localeCompare(right))
}

const fixtureSources = {
  'examples/root-error.ts': 'export type Value = any\n',
  'examples/root-warning.ts': 'export const values = [1].map(value => [value]).flat()\n',
  'src/shared/root-warning.ts': 'export const values = [1].map(value => [value]).flat()\n',
  'mobile/src/root-warning.ts': 'export const values = [1].map(value => [value]).flat()\n',
  'src/shared/anti-error.ts': 'export type Value = unknown\n',
  'src/shared/native-error.ts':
    "import { readFile } from 'node:fs'\nimport { writeFile } from 'node:fs'\nexport { readFile, writeFile }\n",
  'src/shared/typed-error.ts':
    'declare function readValue(): number; export async function value() { await readValue(); return 1 }\n',
  'src/shared/typed-switch-error.ts':
    "type Mode = 'a' | 'b'; export function value(mode: Mode) { switch (mode) { case 'a': return 1; default: return 0 } }\n",
  'src/shared/typed-exemption.test.ts':
    'declare function readValue(): number; export async function value() { await readValue(); return 1 }\n',
  'mobile/src/typed-exclusion.ts':
    'declare function readValue(): number; export async function value() { await readValue(); return 1 }\n',
  'examples/typed-exclusion.ts':
    'declare function readValue(): number; export async function value() { await readValue(); return 1 }\n',
  'src/shared/typed-default-dormant.ts':
    'export function value() { Promise.resolve(1).then(() => {}) }\n',
  'src/renderer/src/NativeAvatar.tsx':
    "export const NativeAvatar = () => <img src='avatar.png' />\n",
  'config/src/renderer/src/NativeAvatar.tsx':
    "export const NativeAvatar = () => <img src='avatar.png' />\n",
  'src/shared/focused.test.ts': "import { it } from 'vitest'\nit.only('focused', () => {})\n",
  'examples/focused-exclusion.test.ts':
    "import { it } from 'vitest'\nit.only('focused', () => {})\n",
  'src/shared/mock-source.ts': "import { vi } from 'vitest'\nvi.mock('fixture', () => ({}))\n",
  'src/shared/mock-exemption.test.ts':
    "import { vi } from 'vitest'\nvi.mock('fixture', () => ({}))\n",
  'mobile/src/mobile-style-exemption.ts': 'export interface Value { readonly value: number }\n',
  'mobile/src/terminal/terminal-webview-engine.generated.ts': 'export const value = 1 as number\n',
  'src/shared/rpc-contract/rpc-params-catalog.generated.ts':
    "import { LinearClient } from '@linear/sdk'\nexport { LinearClient }\n",
  'src/shared/store-whole.ts':
    "import { useAppStore } from '@/store'\nexport const Whole = () => useAppStore()\n",
  'src/shared/store-identity.ts':
    "import { useAppStore } from '@/store'\nexport const Identity = () => useAppStore(state => state)\n",
  'src/shared/store-fresh.ts':
    "import { useAppStore } from '@/store'\nexport const Fresh = () => useAppStore(state => ({ value: state.value }))\n",
  'src/shared/eager-qr.ts': "import QRCode from 'qrcode'\nexport { QRCode }\n",
  'src/shared/quadratic.ts':
    "import { Buffer } from 'node:buffer'\nexport function collect(chunks: Buffer[]) { let total = Buffer.alloc(0); for (const chunk of chunks) { total = Buffer.concat([total, chunk]) } return total }\n",
  'examples/collator-warning.ts':
    "export const sorted = ['b', 'a'].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))\n",
  'src/renderer/src/Scrollbar.tsx':
    'export const Scrollbar = () => <div className="overflow-y-auto" />\n',
  'config/cloud/anti-ignore.ts': 'export type Value = unknown\n',
  'config/src/shared/rpc-contract/rpc-params-catalog.generated.ts': 'export type Value = unknown\n',
  'config/tests/e2e/.cross-version-checkouts/anti-ignore.ts': 'export type Value = unknown\n'
}

async function faultControls(configurations, expanded) {
  const fixture = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'orca-oxlint-faults-'))
  function write(path, contents) {
    const target = join(fixture, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  try {
    symlinkSync(join(repository, 'node_modules'), join(fixture, 'node_modules'), 'junction')
    for (const [name, path] of Object.entries(configurationPaths)) {
      const copied = structuredClone(configurations[name])
      if (copied.jsPlugins) {
        copied.jsPlugins = copied.jsPlugins.map((plugin) => ({
          ...plugin,
          specifier: resolve(repository, dirname(path), plugin.specifier)
        }))
      }
      write(path, JSON.stringify(copied, null, 2))
    }
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
          jsx: 'react-jsx'
        },
        include: ['**/*.ts', '**/*.tsx']
      })
    )
    write('tests/.keep', '')
    write(
      'merged-config.json',
      JSON.stringify(mergedConfiguration(configurations, expanded), null, 2)
    )
    for (const [path, source] of Object.entries(fixtureSources)) {
      write(path, source)
    }
    const baseline = {}
    for (const name of ['root', 'anti', 'native', 'typed']) {
      baseline[name] = await lint(`fault-${name}`, name, fixture)
    }
    const candidate = await lint('fault-merged', 'merged', fixture)
    assert.deepEqual(
      diagnosticUnion({ root: candidate }),
      diagnosticUnion({ root: baseline.root, anti: baseline.anti, native: baseline.native }),
      'Preserve the exact three-scan diagnostic union'
    )
    const rootCodes = new Set(baseline.root.report.diagnostics.map((diagnostic) => diagnostic.code))
    const rootJsNames = new Set(configurations.root.jsPlugins.map((plugin) => plugin.name))
    const rootJsRules = [
      configurations.root.rules,
      ...configurations.root.overrides.map((override) => override.rules)
    ]
      .flatMap((rules) => Object.entries(rules))
      .filter(
        ([name, value]) =>
          rootJsNames.has(name.split('/')[0]) && (Array.isArray(value) ? value[0] : value) !== 'off'
      )
    for (const [name] of rootJsRules) {
      const [plugin, rule] = name.split('/')
      assert(rootCodes.has(`${plugin}(${rule})`), `Exercise root JS rule ${name}`)
    }
    const checks = []
    for (const path of [
      'examples/root-warning.ts',
      'src/shared/root-warning.ts',
      'mobile/src/root-warning.ts',
      'examples/collator-warning.ts'
    ]) {
      const result = await lint(`warning-${checks.length}`, 'merged', fixture, path)
      assert.equal(result.code, 0, 'Root warnings must remain non-fatal')
      assert(
        result.report.diagnostics.length > 0 &&
          result.report.diagnostics.every((diagnostic) => diagnostic.severity === 'warning')
      )
      checks.push({ path, code: result.code, diagnostics: result.report.diagnostics })
    }
    for (const path of [
      'src/shared/native-error.ts',
      'src/shared/focused.test.ts',
      'src/shared/anti-error.ts',
      'src/shared/mock-source.ts',
      'config/src/renderer/src/NativeAvatar.tsx'
    ]) {
      const result = await lint(`failure-${checks.length}`, 'merged', fixture, path)
      assert.equal(result.code, 1, 'Audit failures must remain fatal')
      assert(result.report.diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
      checks.push({ path, code: result.code, diagnostics: result.report.diagnostics })
    }
    for (const path of [
      'src/shared/typed-exemption.test.ts',
      'mobile/src/typed-exclusion.ts',
      'examples/typed-exclusion.ts',
      'examples/focused-exclusion.test.ts',
      'src/shared/mock-exemption.test.ts',
      'mobile/src/mobile-style-exemption.ts',
      'config/cloud/anti-ignore.ts',
      'config/src/shared/rpc-contract/rpc-params-catalog.generated.ts',
      'config/tests/e2e/.cross-version-checkouts/anti-ignore.ts'
    ]) {
      const result = await lint(`exemption-${checks.length}`, 'merged', fixture, path)
      assert.equal(result.code, 0, 'Preserve current exemptions and audit exclusions')
      assert.deepEqual(result.report.diagnostics, [])
      checks.push({ path, code: result.code, diagnostics: [] })
    }
    assert(
      baseline.typed.report.diagnostics.some(
        (diagnostic) => diagnostic.code === 'typescript(await-thenable)'
      )
    )
    assert(
      baseline.typed.report.diagnostics.some(
        (diagnostic) => diagnostic.code === 'typescript(switch-exhaustiveness-check)'
      )
    )
    const result = { fixtureSources, baseline, candidate, checks, success: true }
    writeFileSync(join(directory, 'fault-controls.json'), JSON.stringify(result, null, 2))
    return result
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

function requireClean(result) {
  assert.equal(result.code, 0, readFileSync(result.output, 'utf8'))
  assert.deepEqual(result.report.diagnostics, [], 'Compare clean full-repository diagnostics')
}

function synchronizeAntiSlop() {
  synchronousCommand(process.execPath, [
    join(repository, 'config/scripts/sync-anti-slop-plugin.mjs')
  ])
}

async function baselineStage(pair) {
  const start = performance.now()
  synchronizeAntiSlop()
  const wave1 = await Promise.all(
    ['root', 'anti'].map((name) => lint(`${pair}-baseline-${name}`, name))
  )
  const wave2 = await Promise.all(
    ['native', 'typed'].map((name) => lint(`${pair}-baseline-${name}`, name))
  )
  for (const result of [...wave1, ...wave2]) {
    requireClean(result)
  }
  return { totalMs: performance.now() - start, wave1, wave2 }
}

async function candidateStage(pair) {
  const start = performance.now()
  synchronizeAntiSlop()
  writeFileSync(
    temporaryConfig,
    JSON.stringify(mergedConfiguration(loadConfigurations(), expandedRootConfiguration()), null, 2)
  )
  const preparationMs = performance.now() - start
  const phases = await Promise.all(
    ['merged', 'typed'].map((name) => lint(`${pair}-candidate-${name}`, name))
  )
  for (const result of phases) {
    requireClean(result)
  }
  return { totalMs: performance.now() - start, preparationMs, phases }
}

try {
  synchronizeAntiSlop()
  const configurations = loadConfigurations()
  const expanded = expandedRootConfiguration()
  writeFileSync(
    temporaryConfig,
    JSON.stringify(mergedConfiguration(configurations, expanded), null, 2)
  )
  writeFileSync(
    join(directory, 'configurations.json'),
    JSON.stringify({ configurations, expanded }, null, 2)
  )
  const inventories = Object.fromEntries(
    await Promise.all(
      ['root', 'anti', 'native', 'typed', 'merged'].map(async (name) => [
        name,
        await fileInventory(name)
      ])
    )
  )
  const expected = new Set(['root', 'anti', 'native'].flatMap((name) => [...inventories[name]]))
  const missing = [...expected].filter((path) => !inventories.merged.has(path))
  const extra = [...inventories.merged].filter((path) => !expected.has(path))
  const inventory = {
    counts: Object.fromEntries(
      Object.entries(inventories).map(([name, files]) => [name, files.size])
    ),
    union: expected.size,
    missing,
    extra
  }
  writeFileSync(join(directory, 'file-inventory.json'), JSON.stringify(inventory, null, 2))
  assert.deepEqual(missing, [], 'Do not omit linted files')
  assert.deepEqual(extra, [], 'Do not expand linted files')
  await faultControls(configurations, expanded)
  const environment = {
    node: process.version,
    arch: process.arch,
    cpus: availableParallelism(),
    threads,
    typescriptParser: ts.version,
    sourceSha: synchronousCommand('git', ['rev-parse', 'HEAD']).trim(),
    configurationSha256: createHash('sha256').update(JSON.stringify(configurations)).digest('hex')
  }
  writeFileSync(join(directory, 'environment.json'), JSON.stringify(environment, null, 2))
  const comparisons = []
  const orders =
    process.env.ORCA_OXLINT_PILOT_CONTROLS_ONLY === '1'
      ? []
      : [
          ['baseline', 'candidate'],
          ['candidate', 'baseline'],
          ['baseline', 'candidate']
        ]
  for (const [index, order] of orders.entries()) {
    const stages = {}
    for (const variant of order) {
      stages[variant] = await (variant === 'baseline'
        ? baselineStage(index + 1)
        : candidateStage(index + 1))
    }
    const comparison = {
      pair: index + 1,
      order,
      ...stages,
      savedMs: stages.baseline.totalMs - stages.candidate.totalMs
    }
    comparisons.push(comparison)
    writeFileSync(
      join(directory, 'comparison.json'),
      JSON.stringify({ environment, inventory, comparisons }, null, 2)
    )
    console.log(
      JSON.stringify({
        pair: comparison.pair,
        order,
        baselineMs: comparison.baseline.totalMs,
        candidateMs: comparison.candidate.totalMs,
        savedMs: comparison.savedMs
      })
    )
  }
} finally {
  rmSync(temporaryConfig, { force: true })
}
