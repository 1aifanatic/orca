import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import stock from '../../../../config/vitest.config.ts'

const profileDirectory = resolve('notes/bun-migration/performance/serialize-grid-cpu-explicit-worker-argv-diagnostic/owned-cpu-profiles')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Isolated CI diagnostic only')
assert.ok(Array.isArray(stock.test.projects))
let selected = 0
const projects = stock.test.projects.map(project => {
  assert.ok(project && typeof project === 'object' && !Array.isArray(project) && project.test)
  if (project.test.name !== 'bun') return project
  selected++
  assert.equal(project.test.pool, 'forks')
  assert.deepStrictEqual(project.test.execArgv, ['--no-experimental-webstorage', '--expose-gc'])
  return { ...project, test: { ...project.test,
    execArgv: [...project.test.execArgv, '--cpu-prof', `--cpu-prof-dir=${profileDirectory}`]
  } }
})
assert.equal(selected, 1, 'Only the actual ordinary Bun project receives CPU profiler flags')
export default { ...stock, test: { ...stock.test, projects } }
