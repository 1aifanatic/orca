import { expect, it, vi } from 'vitest'
import scope from './pullfrog-review-scope.cjs'

it('groups a current review by PR while leaving other agent tasks independent', async () => {
  const get = vi.fn(async () => ({ data: { state: 'open', head: { sha: 'current' } } }))
  const core = { setOutput: vi.fn(), warning: vi.fn() }
  const context = {
    repo: { owner: 'stablyai', repo: 'orca' },
    runId: 7,
    payload: { inputs: { name: 'Review #42 [abc]' } }
  }
  const github = { rest: { pulls: { get } } }
  await scope.reviewScope({ core, context, github })
  expect(get).toHaveBeenCalledWith({ owner: 'stablyai', repo: 'orca', pull_number: 42 })
  expect(core.setOutput).toHaveBeenCalledWith('group', 'pullfrog-pr-42')
  expect(core.setOutput).toHaveBeenCalledWith('head', 'current')
  get.mockClear()
  await scope.reviewScope({
    core,
    github,
    context: { ...context, payload: { inputs: { name: 'Investigate #42' } } }
  })
  expect(get).not.toHaveBeenCalled()
  expect(core.setOutput).toHaveBeenLastCalledWith('current', 'true')
})

it('coalesces only explicit or recognized PR review identities', () => {
  expect(scope.reviewNumber({ name: 'Review #23532 [85jpk]' })).toBe(23532)
  expect(scope.reviewNumber({ name: 'Review new commits on #22727 [24lpq]' })).toBe(22727)
  expect(scope.reviewNumber({ pull_request_number: '123' })).toBe(123)
  for (const name of ['Fix #123', 'Review #12; echo test', 'Review #123', '', 'Review #0 [abc]']) {
    expect(scope.reviewNumber({ name })).toBeNull()
  }
})

it('skips closed or explicitly stale reviews and tolerates lookup failure', async () => {
  for (const data of [
    { state: 'closed', head: { sha: 'a' } },
    { state: 'open', head: { sha: 'b' } }
  ]) {
    const core = { setOutput: vi.fn(), warning: vi.fn() }
    await scope.reviewScope({
      core,
      context: {
        repo: {},
        runId: 1,
        payload: { inputs: { pull_request_number: '1', head_sha: 'a' } }
      },
      github: { rest: { pulls: { get: async () => ({ data }) } } }
    })
    expect(core.setOutput).toHaveBeenCalledWith('current', 'false')
    expect(core.setOutput).not.toHaveBeenCalledWith('group', 'pullfrog-pr-1')
  }
  const core = { setOutput: vi.fn(), warning: vi.fn() }
  await scope.reviewScope({
    core,
    context: { repo: {}, runId: 2, payload: { inputs: { pull_request_number: '1' } } },
    github: {
      rest: {
        pulls: {
          get: async () => {
            throw new Error('offline')
          }
        }
      }
    }
  })
  expect(core.setOutput).toHaveBeenCalledWith('group', 'pullfrog-run-2')
  expect(core.warning).toHaveBeenCalled()
})
