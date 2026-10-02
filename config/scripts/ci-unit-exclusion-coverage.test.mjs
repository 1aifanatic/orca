import { globSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { defaultExclude } from 'vitest/config'
import { describe, expect, it } from 'vitest'
import { CROSS_VERSION_WIRE_DIR, UNIT_INCLUDE, discoverUnitFiles } from './ci-unit-files.mjs'

function posixPaths(files) {
  return files.map((file) => file.replaceAll('\\', '/'))
}

function workflowJobs(path) {
  return Object.values(parse(readFileSync(path, 'utf8')).jobs)
}

// Jobs of pr.yml plus the reusable workflows it calls, since those run on every PR too.
function prJobs() {
  const jobs = workflowJobs('.github/workflows/pr.yml')
  const called = jobs
    .map((job) => job.uses)
    .filter((uses) => typeof uses === 'string' && uses.startsWith('./.github/workflows/'))
  return [...jobs, ...called.flatMap((uses) => workflowJobs(uses.slice(2)))]
}

// Path arguments of every PR step that runs vitest; a trailing slash means a directory.
function vitestPathArguments() {
  return prJobs()
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run)
    .filter((run) => typeof run === 'string' && /\bvitest\b/.test(run))
    .flatMap((run) => run.replaceAll('\\\n', ' ').split(/\s+/))
    .map((token) => token.replace(/^['"]|['"]$/g, ''))
    .filter((token) => /^(?:src|config|tests|mobile)\//.test(token))
}

function runByPrVitestStep(file, pathArguments) {
  return pathArguments.some(
    (path) => path === file || (path.endsWith('/') && file.startsWith(path))
  )
}

describe('unit files kept out of the sharded test job', () => {
  it('each still runs in some PR job', () => {
    const sharded = new Set(discoverUnitFiles())
    const excluded = posixPaths(globSync(UNIT_INCLUDE, { exclude: defaultExclude })).filter(
      (file) => !sharded.has(file)
    )
    const pathArguments = vitestPathArguments()

    expect(excluded.length).toBeGreaterThan(0)
    // Why: an excluded file no step names guards nothing, and nothing else reports it.
    expect(excluded.filter((file) => !runByPrVitestStep(file, pathArguments))).toEqual([])
  })

  it('runs the whole cross-version-wire directory, not a list of its files', () => {
    expect(vitestPathArguments()).toContain(CROSS_VERSION_WIRE_DIR)
  })

  it('names every cross-version-wire test so the unit include picks it up', () => {
    // Why: a directory argument only reaches files the vitest include matches; any other name is silently skipped.
    const tests = posixPaths(
      globSync(`${CROSS_VERSION_WIRE_DIR}**/*.{test,spec}.{js,cjs,mjs,ts,tsx}`)
    )
    const included = new Set(posixPaths(globSync(UNIT_INCLUDE)))
    expect(tests.length).toBeGreaterThan(0)
    expect(tests.filter((file) => !included.has(file))).toEqual([])
  })
})
