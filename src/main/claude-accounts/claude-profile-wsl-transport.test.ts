import { chmodSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  executable: '',
  root: '',
  running: true,
  run: vi.fn(),
  runtime: vi.fn()
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getAppPath: () => mocks.root, getPath: () => mocks.root })
}))
vi.mock('../ssh/relay-bundle-paths', () => ({ relayBundleCandidates: () => [mocks.root] }))
vi.mock('../wsl/wsl-executable-path', () => ({ resolveWslExecutablePath: () => mocks.executable }))
vi.mock('../wsl-interop-spawn-directory', () => ({ resolveWslInteropSpawnCwd: () => mocks.root }))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: async (paths: string[]) => (mocks.running ? paths : [])
}))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: mocks.run }))
vi.mock('../wsl/wsl-pinned-runtime', () => ({ ensureWslPinnedRuntime: mocks.runtime }))
import { prepareClaudeWslGuest, withdrawClaudeWslPointer } from './claude-profile-wsl-transport'
beforeEach(() => {
  mocks.root = mkdtempSync(join(tmpdir(), 'fake-wsl-'))
  mocks.executable = join(mocks.root, 'wsl.exe')
  mocks.running = true
  mocks.run.mockReset().mockImplementation(async (spec) => {
    let stdout = '/mnt/c/fake-helper.cjs'
    if (spec.args?.[0] === '-c') {
      const script: string = spec.args[1]
      const begin = script.match(/__ORCA_WSL_CAPTURE_BEGIN_[a-z0-9]+__/)?.[0]
      const end = script.match(/__ORCA_WSL_CAPTURE_END_[a-z0-9]+__/)?.[0]
      stdout = `guest banner\n${begin}2.1.0 (Claude Code)${end}`
    }
    return { code: 0, stdout, stderr: '', timedOut: false }
  })
  mocks.runtime.mockReset().mockImplementation(async (run) => {
    await run({ program: 'uname', args: ['-m'], loginPath: 'none' })
    return { executable: '/home/fake/.cache/orca/runtimes/pinned/bin/node', home: '/home/fake' }
  })
  writeFileSync(join(mocks.root, 'claude-profile-wsl.cjs'), 'FAKE BUNDLE')
  writeFileSync(
    mocks.executable,
    `#!${process.execPath}\nlet s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(join(mocks.root, 'request.json'))},JSON.stringify({args:process.argv.slice(2),request:JSON.parse(s)}));process.stdout.write(JSON.stringify({ready:true,provisioned:true}));});\n`
  )
  chmodSync(mocks.executable, 0o700)
})
afterEach(() => rmSync(mocks.root, { recursive: true, force: true }))
it('uses fake wsl.exe with literal --exec argv and a fenced version probe, never a local shell', async () => {
  const guest = await prepareClaudeWslGuest('Ubuntu with spaces')
  await guest.request({
    action: 'setup',
    distro: 'Ubuntu with spaces',
    userHome: guest.home,
    accountId: 'a',
    hooksEnabled: true
  })
  const result = JSON.parse(readFileSync(join(mocks.root, 'request.json'), 'utf8'))
  expect(result.args).toEqual([
    '-d',
    'Ubuntu with spaces',
    '--exec',
    '/usr/bin/env',
    '-u',
    'NODE_OPTIONS',
    '/home/fake/.cache/orca/runtimes/pinned/bin/node',
    '/mnt/c/fake-helper.cjs'
  ])
  expect(result.request.claudeVersion).toBe('2.1.0')
  expect(
    mocks.run.mock.calls.some(([spec]) => spec.args?.[1]?.includes('__ORCA_WSL_CAPTURE_BEGIN_'))
  ).toBe(true)
})
it('refuses stopped distros before any guest command and again before publishing', async () => {
  mocks.running = false
  await expect(prepareClaudeWslGuest('Stopped')).rejects.toThrow('not running')
  expect(mocks.run).not.toHaveBeenCalled()
  mocks.running = true
  const guest = await prepareClaudeWslGuest('Ubuntu')
  mocks.running = false
  await expect(
    guest.request({
      action: 'publish',
      distro: 'Ubuntu',
      userHome: guest.home,
      accountId: 'a',
      hooksEnabled: false
    })
  ).rejects.toThrow('not running')
})
it('surfaces runtime and process failures without substituting a personal Claude launch', async () => {
  mocks.runtime.mockRejectedValueOnce(new Error('download refused'))
  await expect(prepareClaudeWslGuest('Ubuntu')).rejects.toThrow('download refused')
  const guest = await prepareClaudeWslGuest('Ubuntu')
  writeFileSync(
    mocks.executable,
    `#!${process.execPath}\nprocess.stderr.write('pinned runtime missing');process.exit(1)\n`
  )
  await expect(
    guest.request({
      action: 'publish',
      distro: 'Ubuntu',
      userHome: guest.home,
      accountId: 'a',
      hooksEnabled: false
    })
  ).rejects.toThrow('pinned runtime missing')
})

it('withdraws a stale pointer even without a usable pinned runtime', async () => {
  mocks.runtime.mockRejectedValue(new Error('missing runtime'))
  await withdrawClaudeWslPointer('Ubuntu')
  expect(mocks.runtime).not.toHaveBeenCalled()
  expect(mocks.run).toHaveBeenCalledWith(
    expect.objectContaining({
      distro: 'Ubuntu',
      loginPath: 'none',
      script: expect.stringContaining('selected-wsl')
    })
  )
})
