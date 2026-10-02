import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '../..')
const manifests = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.pnpmfile.cjs',
  'native/windows-registry/package.json'
]
const pilotSources = [
  '.github/actions/install-node-dependencies/action.yml',
  '.github/workflows/ci-pnpm-verification-pilot.yml',
  'config/scripts/ci-pnpm-root-store-pilot.mjs',
  ...globSync('config/patches/**/*', { cwd: repository })
    .filter((path) => statSync(join(repository, path)).isFile())
    .sort()
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fileSha(path) {
  return sha256(readFileSync(path))
}

function sourceFiles(paths) {
  return Object.fromEntries(
    paths.map((path) => [
      path,
      existsSync(join(repository, path)) ? fileSha(join(repository, path)) : null
    ])
  )
}

function installedInventory() {
  const packages = readdirSync(join(repository, 'node_modules/.pnpm'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => entry.name)
    .sort()
  assert(packages.length > 0, 'Installed package inventory is empty')
  const nativePackages = packages.filter((name) =>
    /^(?:@esbuild\+|@parcel\+watcher|@rollup\+rollup-|better-sqlite3@|cpu-features@|electron@|esbuild@|node-pty@|sherpa-onnx)/.test(
      name
    )
  )
  assert(
    nativePackages.some((name) => name.startsWith('node-pty@')),
    'node-pty package is missing'
  )
  return {
    packages,
    packageSha: sha256(JSON.stringify(packages)),
    nativePackages,
    nativePackageSha: sha256(JSON.stringify(nativePackages)),
    installedLockfileSha: fileSha(join(repository, 'node_modules/.pnpm/lock.yaml'))
  }
}

function identity(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'This pilot requires a hosted Actions job')
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch')
  assert.equal(process.platform, 'darwin')
  assert.equal(process.arch, 'x64')
  assert.equal(env.RUNNER_OS, 'macOS')
  assert.equal(env.RUNNER_ARCH, 'X64')
  assert.equal(process.version, 'v24.21.0', 'The pilot pins its install Node version')
  assert.equal(env.PILOT_PNPM_VERSION || env.ORCA_CI_PNPM_STORE_PILOT_PNPM_VERSION, '12.0.0')
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/)
  assert.match(env.GITHUB_RUN_ID ?? '', /^[0-9]+$/)
  assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/)
  assert.equal(env.PILOT_SOURCE_SHA || env.ORCA_CI_PNPM_STORE_PILOT_SOURCE_SHA, env.GITHUB_SHA)
  assert(env.GITHUB_WORKFLOW_SHA, 'Workflow source SHA is unavailable')
  assert.equal(env.GITHUB_WORKFLOW_SHA, env.GITHUB_SHA, 'Workflow and checkout must share a source')
  assert.equal(env.ORCA_BACKGROUND_LAUNCH, '1')
  return {
    sourceSha: env.GITHUB_SHA,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    ref: env.GITHUB_REF,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    runnerName: env.RUNNER_NAME,
    imageOS: env.ImageOS,
    imageVersion: env.ImageVersion,
    node: process.version,
    pnpm: '12.0.0',
    platform: process.platform,
    arch: process.arch
  }
}

function writeReport(path, report) {
  assert(isAbsolute(path), 'Pilot receipt must use an absolute runner-local path')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.pending`, `${JSON.stringify(report, null, 2)}\n`)
  renameSync(`${path}.pending`, path)
  console.log(
    JSON.stringify({
      phase: report.phase,
      arm: report.arm,
      sample: report.sample,
      restoreIntervalMs: report.restoreIntervalMs,
      frozenInstallIntervalMs: report.frozenInstallIntervalMs,
      sourceSha: report.identity.sourceSha,
      storeKey: report.storeKey,
      verificationKey: report.verificationKey
    })
  )
}

export function validateCacheEvidence(report, env) {
  assert.equal(
    env.PILOT_VERIFICATION_CACHE_HIT,
    'true',
    'Both arms require an exact verification hit'
  )
  assert.equal(env.PILOT_VERIFICATION_KEY, env.ORCA_CI_PNPM_STORE_PILOT_EXPECTED_VERIFICATION_KEY)
  assert.equal(
    env.PILOT_VERIFICATION_MATCHED_KEY,
    env.PILOT_VERIFICATION_KEY,
    'Both arms must restore the exact seed snapshot'
  )
  assert(
    env.ORCA_CI_PNPM_STORE_PILOT_EXPECTED_VERIFICATION_SHA,
    'Seed verification digest is missing'
  )
  if (report.arm === 'restore-only') {
    assert.equal(
      env.PILOT_STORE_CACHE_HIT,
      'true',
      'Baseline must restore the exact root-store key'
    )
    assert.equal(env.PILOT_STORE_MATCHED_KEY, report.storeKey, 'A fallback cache is not a baseline')
  } else {
    assert.equal(report.arm, 'false')
    assert.equal(env.PILOT_STORE_CACHE_HIT || '', '', 'Treatment must not attempt a store restore')
    assert.equal(env.PILOT_STORE_MATCHED_KEY || '', '')
  }
}

function assertEmptyStore(path) {
  assert(isAbsolute(path), 'The default pnpm store path is unavailable')
  assert.deepEqual(
    existsSync(path) ? readdirSync(path) : [],
    [],
    'Pilot needs an empty default store'
  )
}

function seed(env, path) {
  const report = {
    phase: 'seed',
    identity: identity(env),
    manifests: sourceFiles(manifests),
    sources: sourceFiles(pilotSources),
    verificationKey: env.PILOT_VERIFICATION_KEY,
    verificationPolicyKey: env.PILOT_VERIFICATION_POLICY_KEY,
    verificationSha: fileSha(env.PILOT_VERIFICATION_PATH),
    inventory: installedInventory()
  }
  assert(report.verificationKey, 'Seed verification key is missing')
  assert(report.verificationPolicyKey, 'Seed policy key is missing')
  assert.equal(
    report.verificationKey,
    `${report.verificationPolicyKey}-pilot-${report.identity.runId}-${report.identity.runAttempt}-${report.identity.sourceSha}`
  )
  writeReport(path, report)
  for (const [name, value] of Object.entries({
    'verification-key': report.verificationKey,
    'verification-sha': report.verificationSha,
    'manifest-sha': sha256(JSON.stringify(report.manifests)),
    'source-sha': sha256(JSON.stringify(report.sources)),
    'package-sha': report.inventory.packageSha,
    'native-package-sha': report.inventory.nativePackageSha,
    'installed-lockfile-sha': report.inventory.installedLockfileSha,
    'image-version': report.identity.imageVersion
  })) {
    assert(value, `Seed ${name} is missing`)
    appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`)
  }
}

function main() {
  const env = process.env
  const phase = process.argv[2]
  const path = env.ORCA_CI_PNPM_STORE_PILOT_RECEIPT
  assert(path, 'Pilot receipt path is missing')
  if (phase === 'seed') {
    seed(env, path)
    return
  }
  if (phase === 'preflight') {
    for (const key of Object.keys(env)) {
      assert.notEqual(
        key.toLowerCase(),
        'npm_config_store_dir',
        'The pilot must use the default store'
      )
    }
    assertEmptyStore(env.PILOT_STORE_PATH)
    const report = {
      phase,
      identity: identity(env),
      arm: env.ORCA_CI_PNPM_STORE_PILOT_ARM,
      sample: Number(env.ORCA_CI_PNPM_STORE_PILOT_SAMPLE),
      storePath: env.PILOT_STORE_PATH,
      storeKey: env.PILOT_STORE_KEY,
      emptyStoreBeforeRestore: true,
      manifests: sourceFiles(manifests),
      sources: sourceFiles(pilotSources),
      restoreStartedAt: Date.now()
    }
    assert(['restore-only', 'false'].includes(report.arm))
    assert([1, 2, 3].includes(report.sample))
    assert.equal(
      report.storeKey,
      `node-cache-macOS-x64-pnpm-${env.ORCA_CI_PNPM_STORE_PILOT_LOCKFILE_HASH}`
    )
    assert.equal(
      sha256(JSON.stringify(report.manifests)),
      env.ORCA_CI_PNPM_STORE_PILOT_EXPECTED_MANIFEST_SHA
    )
    assert.equal(
      sha256(JSON.stringify(report.sources)),
      env.ORCA_CI_PNPM_STORE_PILOT_EXPECTED_SOURCE_SHA
    )
    assert.equal(report.identity.imageVersion, env.ORCA_CI_PNPM_STORE_PILOT_EXPECTED_IMAGE_VERSION)
    writeReport(path, report)
    return
  }
  const report = JSON.parse(readFileSync(path, 'utf8'))
  const observedAt = Date.now()
  if (phase === 'install-start') {
    assert.equal(report.phase, 'preflight')
    validateCacheEvidence(report, env)
    if (report.arm === 'false') {
      assertEmptyStore(report.storePath)
    } else {
      assert(
        readdirSync(report.storePath).length > 0,
        'The exact baseline archive contains no store files'
      )
    }
    report.verificationKey = env.PILOT_VERIFICATION_KEY
    report.verificationMatchedKey = env.PILOT_VERIFICATION_MATCHED_KEY
    report.verificationSha = fileSha(env.PILOT_VERIFICATION_PATH)
    assert.equal(report.verificationSha, env.ORCA_CI_PNPM_STORE_PILOT_EXPECTED_VERIFICATION_SHA)
    report.storeCacheHit = env.PILOT_STORE_CACHE_HIT || ''
    report.storeMatchedKey = env.PILOT_STORE_MATCHED_KEY || ''
    report.restoreIntervalMs = observedAt - report.restoreStartedAt
    report.installStartedAt = Date.now()
  } else {
    assert.equal(phase, 'install-finished')
    assert.equal(report.phase, 'install-start')
    report.frozenInstallIntervalMs = observedAt - report.installStartedAt
    report.inventory = installedInventory()
    assert.deepEqual(
      sourceFiles(manifests),
      report.manifests,
      'Install mutated its manifests or policy'
    )
    assert.deepEqual(
      sourceFiles(pilotSources),
      report.sources,
      'Pilot source changed during installation'
    )
    for (const [field, expected] of [
      ['packageSha', env.ORCA_CI_PNPM_STORE_PILOT_EXPECTED_PACKAGE_SHA],
      ['nativePackageSha', env.ORCA_CI_PNPM_STORE_PILOT_EXPECTED_NATIVE_PACKAGE_SHA],
      ['installedLockfileSha', env.ORCA_CI_PNPM_STORE_PILOT_EXPECTED_INSTALLED_LOCKFILE_SHA]
    ]) {
      assert.equal(report.inventory[field], expected, `Installed ${field} differs from the seed`)
    }
    report.verificationShaAfterInstall = fileSha(env.PILOT_VERIFICATION_PATH)
    report.measuredIntervalMs = report.restoreIntervalMs + report.frozenInstallIntervalMs
    report.limit =
      'Restore interval includes verification and inter-step overhead; frozen install interval includes recorder overhead. Hosted cache logs isolate transfer and extraction. Fresh VMs differ.'
  }
  report.phase = phase
  writeReport(path, report)
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main()
}
