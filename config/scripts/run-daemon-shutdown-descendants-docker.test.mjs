import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ target: '', builds: [], runs: [], gitReads: [] }))
vi.mock('./build-orcad-bun.mjs', () => ({
  materializeRuntime: async (target, destination) => {
    state.target = target
    writeFileSync(destination, 'verified-runtime-fixture')
  }
}))
vi.mock('./script-child-process.mjs', () => ({
  runProcessSync: ({ program, args }) => {
    if (program === 'git') {
      state.gitReads.push(args[1])
      return {
        code: 0,
        stdout: readFileSync(args[1].split(':').slice(1).join(':'), 'utf8'),
        stderr: ''
      }
    }
    if (args[0] === 'build') {
      const context = args.at(-1)
      state.builds.push({
        runtime: readFileSync(join(context, 'bun-runtime'), 'utf8'),
        dockerfile: readFileSync(join(context, 'Dockerfile'), 'utf8'),
        fixture: readFileSync(join(context, 'fixture.cjs'), 'utf8'),
        candidate: readFileSync(join(context, 'candidate.cjs'), 'utf8'),
        baseline: existsSync(join(context, 'baseline.cjs')),
        context
      })
    }
    if (args[0] === 'run') {
      state.runs.push(args)
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}))

const argv = process.argv
const platform = process.env.ORCA_DOCKER_PLATFORM
afterEach(() => {
  process.argv = argv
  if (platform === undefined) {
    delete process.env.ORCA_DOCKER_PLATFORM
  } else {
    process.env.ORCA_DOCKER_PLATFORM = platform
  }
  state.builds.length = 0
  state.runs.length = 0
  state.gitReads.length = 0
  state.target = ''
  vi.resetModules()
})

async function run(target, args = []) {
  process.env.ORCA_DOCKER_PLATFORM = target
  process.argv = ['node', 'runner', ...args]
  await import('./run-daemon-shutdown-descendants-docker.mjs')
}

describe('Bun daemon descendant shutdown oracle', () => {
  it.each([
    ['linux/amd64', 'linux-x64-glibc'],
    ['linux/arm64', 'linux-arm64-glibc']
  ])('stages the verified runtime and real provider for %s', async (platform, target) => {
    await run(platform)
    expect(state.target).toBe(target)
    const staged = state.builds[0]
    expect(staged.runtime).toBe('verified-runtime-fixture')
    expect(staged.dockerfile).not.toMatch(/node-pty|npm|FROM node:/)
    expect(staged.fixture).toContain('spawnBunPty({')
    expect(staged.candidate).toContain('spawnBunPty')
    expect(staged.candidate).not.toMatch(/require\(["']node-pty["']\)/)
    expect(state.runs[0]).toContain('candidate')
    expect(existsSync(staged.context)).toBe(false)
  })

  it('compares selected baseline shutdown sources on the same Bun provider', async () => {
    await run('linux/amd64', ['--baseline', 'baseline-ref'])
    expect(state.gitReads).toHaveLength(5)
    expect(state.gitReads.every((source) => source.startsWith('baseline-ref:'))).toBe(true)
    expect(state.builds[0].baseline).toBe(true)
    expect(state.runs.map((args) => args.at(-1))).toEqual(['baseline', 'candidate'])
  })

  it('rejects unsupported architectures before materializing a runtime', async () => {
    await expect(run('linux/386')).rejects.toThrow('Unsupported daemon oracle platform')
    expect(state.target).toBe('')
    expect(state.builds).toEqual([])
  })
})
