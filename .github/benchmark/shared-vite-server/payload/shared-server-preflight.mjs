// Read resolved stock configuration before test scheduling; no alternate runner.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import { configDefaults } from 'vitest/config'
import { discoverUnitFiles } from '../../../../config/scripts/ci-unit-files.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value, (key, item) => {
  if (['token', 'tokenPath', 'tokenCreated'].includes(key)) return undefined
  if (typeof item === 'function') return { functionName: item.name, sourceSha256: hash(String(item)) }
  if (item instanceof RegExp) return { regexp: item.source, flags: item.flags }
  return item
}))
// Mirrors pinned resolveTestConfig reporter normalization; preserves raw declarations.
const normalizedReporters = value => {
  if (!value) return []
  if (!Array.isArray(value)) return typeof value === 'string' ? [[value, {}]] : [value]
  return value.map(reporter => Array.isArray(reporter) ? [reporter[0], reporter[1] || {}]
    : typeof reporter === 'string' ? [reporter, {}] : reporter)
}
const rel = (root, file) => relative(root, file).replaceAll('\\', '/')
const sort = rows => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

export function comparable(snapshot) {
  const value = clone(snapshot)
  delete value.identities
  delete value.phase
  delete value.allowedMetadata
  delete value.observedCoordinator
  return value
}

export async function observeBeforeCases(ctx) {
  const phase = process.env.ORCA_SHARED_SERVER_PHASE
  const runtime = process.env.ORCA_SHARED_SERVER_RUNTIME
  assert.ok(['before', 'after'].includes(phase))
  assert.ok(['bun', 'node'].includes(runtime))
  assert.equal(Boolean(process.versions.bun), runtime === 'bun')
  const plan = JSON.parse(readFileSync(process.env.ORCA_SHARED_SERVER_PLAN))
  if (runtime === 'bun') assert.equal(globalThis.Bun.revision, plan.expectedBunRuntimeRevision)
  const root = ctx.config.root
  const identities = new Map()
  const identity = object => {
    assert.ok(object !== null && ['object', 'function'].includes(typeof object))
    if (!identities.has(object)) identities.set(object, identities.size + 1)
    return identities.get(object)
  }
  const rootServer = identity(ctx.vite)
  const rootObjects = { resolver: identity(ctx._resolver), fetcher: identity(ctx._fetcher), runner: identity(ctx.runner) }
  const projects = [...ctx.projects].sort((a, b) => a.name.localeCompare(b.name))
  const names = runtime === 'bun' ? ['bun', 'node-measurement', 'node-runtime'] : ['node', 'node-measurement']
  assert.deepEqual(projects.map(project => project.name), names)
  const rawReporterDeclaration = clone(ctx.config._rawTestConfig.reporters ?? null)
  const defaultReporterDeclaration = clone(configDefaults.reporters)
  const declaredReporters = rawReporterDeclaration ?? defaultReporterDeclaration
  const expectedParentReporters = normalizedReporters(declaredReporters)
  const rows = []
  const identityRows = []
  const metadata = []
  for (const project of projects) {
    const config = project.config
    const worker = clone(project.serializedConfig)
    assert.equal(config.fsModuleCache, true)
    assert.equal(config.isolate, true)
    assert.equal(config.maxWorkers, 4)
    assert.equal(config.testTimeout, 30000)
    assert.equal(config.hookTimeout, 60000)
    assert.deepEqual(config.setupFiles.map(file => rel(root, file)), plan.setupFiles)
    assert.deepEqual(config.execArgv, ['--no-experimental-webstorage', '--expose-gc'])
    assert.equal(config.sequence.groupOrder, project.name === 'node-measurement' ? 2 : 1)
    assert.equal(config.env.ORCA_VITEST_RUNTIME, project.name === 'node-measurement' ? (runtime === 'bun' ? 'node-runtime' : 'node') : project.name)
    assert.equal(config.pool, project.name === 'bun' || runtime === 'node' ? 'forks' : 'node-runtime')
    if (phase === 'after') {
      assert.equal(project.sharedViteServer, true)
      assert.equal(project.vite, ctx.vite)
      assert.equal(config.sequence.sequencer, ctx.config.sequence.sequencer)
      assert.deepEqual(clone(config.reporters), expectedParentReporters)
      assert.equal(config.cache.dir, ctx.config.cache.dir)
    } else {
      assert.equal(project.sharedViteServer, false)
      assert.notEqual(project.vite, ctx.vite)
    }
    const publicConfig = clone(Object.fromEntries(Object.entries(config).filter(([key]) => !key.startsWith('_'))))
    const allowed = {
      name: project.name, sequencer: publicConfig.sequence.sequencer,
      reporters: publicConfig.reporters, cache: publicConfig.cache,
      viteCacheDir: project.vite.config.cacheDir,
      moduleRunnerOptions: clone(config._moduleRunnerOptions ?? null)
    }
    delete publicConfig.sequence.sequencer
    delete publicConfig.reporters
    delete publicConfig.cache
    rows.push({ name: project.name, worker, publicConfig,
      vite: clone({ resolve: project.vite.config.resolve, ssr: project.vite.config.ssr,
        base: project.vite.config.base, mode: project.vite.config.mode,
        env: project.vite.config.env, css: project.vite.config.css }) })
    identityRows.push({ name: project.name, shared: project.sharedViteServer,
      server: identity(project.vite), resolver: identity(project._resolver),
      fetcher: identity(project._fetcher), runner: identity(project.runner) })
    metadata.push(allowed)
  }
  for (const key of ['resolver', 'fetcher', 'runner']) {
    assert.equal(new Set(identityRows.map(row => row[key])).size, projects.length)
    assert.ok(identityRows.every(row => row[key] !== rootObjects[key]))
  }
  const serverCount = new Set([rootServer, ...identityRows.map(row => row.server)]).size
  assert.equal(serverCount, phase === 'after' ? 1 : projects.length + 1)
  assert.deepEqual(ctx.config.include, projects.find(project => project.name === (runtime === 'bun' ? 'bun' : 'node')).config.include)
  assert.deepEqual(ctx.config.exclude, projects.find(project => project.name === 'node-measurement').config.exclude)
  const specifications = await ctx.globTestSpecifications()
  const discovery = sort(specifications.map(spec => ({
    file: rel(root, spec.moduleId), project: spec.project.name, pool: spec.pool,
    groupOrder: spec.project.config.sequence.groupOrder
  })))
  assert.equal(new Set(discovery.map(row => row.file)).size, discovery.length)
  const canonical = discoverUnitFiles()
  assert.deepEqual([...canonical].sort(), [...plan.sourceCanonicalFiles, ...plan.probeFiles].sort())
  const discovered = new Set(discovery.map(row => row.file))
  for (const file of canonical) assert.ok(discovered.has(file), `Canonical file missing: ${file}`)
  const measurement = discovery.filter(row => row.project === 'node-measurement')
  assert.deepEqual(measurement, [{ file: plan.measurementFile, project: 'node-measurement',
    pool: runtime === 'bun' ? 'node-runtime' : 'forks', groupOrder: 2 }])
  for (const route of plan.expectedRoutes[runtime]) {
    assert.deepEqual(discovery.find(row => row.file === route.file), route)
  }
  const snapshot = {
    phase, runtime, seed: Number(process.env.ORCA_SHARED_SERVER_SEED),
    sourceHead: plan.sourceHead, planSha256: hash(readFileSync(process.env.ORCA_SHARED_SERVER_PLAN)),
    root: clone({ include: ctx.config.include, exclude: ctx.config.exclude,
      isolate: ctx.config.isolate, fsModuleCache: ctx.config.fsModuleCache,
      fsModuleCachePath: ctx.config.fsModuleCachePath, maxWorkers: ctx.config.maxWorkers,
      sequence: ctx.config.sequence, reporters: ctx.config.reporters,
      cache: ctx.config.cache, env: ctx.config.env, execArgv: ctx.config.execArgv,
      pool: ctx.config.pool, environment: ctx.config.environment,
      parentRunnerOptions: ctx.config._moduleRunnerOptions, rawReporterDeclaration,
      defaultReporterDeclaration, declaredReporters, normalizedParentReporters: expectedParentReporters }),
    projects: rows, discovery, canonical,
    selectedRoutes: discovery.filter(row => plan.files.includes(row.file)),
    identities: { rootServer, rootObjects, serverCount, projects: identityRows }, allowedMetadata: metadata,
    observedCoordinator: { node: process.versions.node, bun: process.versions.bun ?? null, bunRevision: globalThis.Bun?.revision ?? null,
      executable: process.execPath, expectedNodeVersion: process.env.ORCA_TEST_NODE_VERSION ?? null,
      expectedNodeExecutable: process.env.ORCA_TEST_NODE_EXECUTABLE ?? null },
    beforeTestScheduling: true
  }
  writeFileSync(process.env.ORCA_SHARED_SERVER_PREFIX + '-preflight.json', JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' })
  if (phase === 'after') {
    const baseline = JSON.parse(readFileSync(process.env.ORCA_SHARED_SERVER_BASELINE + '-preflight.json'))
    assert.deepEqual(comparable(snapshot), comparable(baseline), 'Unallowed resolved configuration or discovery difference')
    for (let index = 0; index < metadata.length; index++) {
      const prior = baseline.allowedMetadata[index]
      const next = metadata[index]
      assert.equal(prior.name, next.name)
      assert.deepEqual(next.moduleRunnerOptions, null)
      assert.deepEqual(prior.moduleRunnerOptions, snapshot.root.parentRunnerOptions)
    }
  }
  return snapshot
}
