import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const readYaml = (path) => parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const action = readYaml('../../.github/actions/prepare-xterm-dependencies/action.yml')
const workflow = readYaml('../../.github/workflows/ci-xterm-cache.yml')
const restore = action.runs.steps.find((step) => step.id === 'restore')

it('separates toolchains and restores dependencies without a stale fallback or build results', () => {
  for (const input of [
    'runner.os',
    'runtime.outputs.image',
    'runner.arch',
    'runtime.outputs.node',
    'xterm-upstream.json',
    'regenerate-xterm-patches.mjs',
    'xterm-patch-text.mjs',
    'prepare-xterm-dependencies/action.yml'
  ]) {
    expect(restore.with.key).toContain(input)
  }
  expect(restore.uses).toBe('actions/cache/restore@v5')
  expect(restore.with['restore-keys']).toBeUndefined()
  expect(restore.with.path.trim().split('\n')).toEqual([
    '${{ runner.temp }}/xterm-patch-build/upstream/.git',
    '${{ runner.temp }}/xterm-patch-build/upstream/node_modules'
  ])
})

it('publishes only from main after a successful fresh verification, and skips work on hits', () => {
  expect(workflow.on.pull_request).toBeUndefined()
  expect(workflow.on.push.branches).toEqual(['main'])
  expect(workflow.jobs.seed.if).toBe("github.ref == 'refs/heads/main'")
  expect(workflow.permissions).toEqual({ contents: 'read' })
  const steps = workflow.jobs.seed.steps
  const verify = steps.find((step) => step.name === 'Verify and populate dependencies')
  const save = steps.find((step) => step.uses === 'actions/cache/save@v5')
  expect(verify.if).toBe("steps.cache.outputs.cache-hit != 'true'")
  expect(save.if).toBe(verify.if)
  expect(save.with.path).toBe(restore.with.path)
  expect(save.with.key).toBe('${{ steps.cache.outputs.cache-key }}')
  expect(steps.indexOf(save)).toBeGreaterThan(steps.indexOf(verify))
  expect(verify.run).toContain('regenerate-xterm-patches.mjs --check')
  const pr = readYaml('../../.github/workflows/pr.yml').jobs.xterm_patch_sync.steps
  expect(pr.some((step) => step.uses === './.github/actions/prepare-xterm-dependencies')).toBe(true)
  expect(pr.some((step) => /cache(?:\/save)?@/.test(step.uses ?? ''))).toBe(false)
  expect(pr.at(-1).run).toContain('regenerate-xterm-patches.mjs --check')
})
