import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCodexCliInstallation } from './codex-cli-installation'
import { CodexCliInstallationCache } from './codex-cli-installation-cache'
import { codexCliInstallation } from '../../shared/codex-cli-installation'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('../../shared/child-process/run-process', async (original) => ({
  ...(await original<object>()),
  runProcess
}))

const roots: string[] = []
async function binary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codex-installation-test-'))
  roots.push(root)
  const file = join(root, 'codex')
  await writeFile(file, 'fake binary; never executed')
  return file
}
function prints(stdout: string, timedOut = false): void {
  runProcess.mockResolvedValue({ code: 0, stdout, stderr: '', timedOut })
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  runProcess.mockReset()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Codex binary version cache', () => {
  it('shares concurrent probes and caches the version for ordinary starts', async () => {
    const program = await binary()
    prints('codex-cli 0.136.0')
    const input = { program, env: { PATH: '/launch/path' } }
    const results = await Promise.all([
      readCodexCliInstallation(input),
      readCodexCliInstallation(input)
    ])
    expect(results.every((result) => result.status === 'ready')).toBe(true)
    await readCodexCliInstallation(input)
    expect(runProcess).toHaveBeenCalledTimes(1)
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program,
        env: input.env,
        args: ['--version'],
        timeoutMs: 5_000,
        maxOutputBytes: 4_096
      })
    )
  })

  it('rechecks an updated binary and a different resolved path', async () => {
    const program = await binary()
    prints('codex-cli 0.135.0')
    expect((await readCodexCliInstallation({ program })).status).toBe('unsupported')
    await writeFile(program, 'updated fake binary of a different size')
    prints('codex-cli 0.136.0')
    expect((await readCodexCliInstallation({ program })).status).toBe('ready')
    await utimes(program, new Date(), new Date(Date.now() + 10_000))
    await readCodexCliInstallation({ program })
    await readCodexCliInstallation({ program: await binary() })
    expect(runProcess).toHaveBeenCalledTimes(4)
  })

  it('allows a timeout, then retries the unchanged binary after the bounded cache expires', async () => {
    const program = await binary()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    prints('codex-cli 0.135.0', true)
    expect((await readCodexCliInstallation({ program })).status).toBe('unknown')
    prints('codex-cli 0.136.0')
    expect((await readCodexCliInstallation({ program })).status).toBe('unknown')
    vi.setSystemTime(30_001)
    expect((await readCodexCliInstallation({ program })).status).toBe('ready')
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it('notices an npm package update even when the launcher is unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-npm-test-'))
    roots.push(root)
    await mkdir(join(root, 'bin'))
    const program = join(root, 'bin', 'codex.js')
    await writeFile(program, 'unchanged npm launcher; never executed')
    await writeFile(join(root, 'package.json'), '{"version":"0.135.0"}')
    prints('codex-cli 0.135.0')
    expect((await readCodexCliInstallation({ program })).status).toBe('unsupported')
    await writeFile(join(root, 'package.json'), '{"version":"0.136.0","updated":true}')
    prints('codex-cli 0.136.0')
    expect((await readCodexCliInstallation({ program })).status).toBe('ready')
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it('proves a missing binary from the filesystem and allows an installed binary with a broken interpreter', async () => {
    const program = await binary()
    expect((await readCodexCliInstallation({ program: join(program, 'missing') })).status).toBe(
      'unknown'
    )
    expect(
      (await readCodexCliInstallation({ program: join(program, '..', 'missing') })).status
    ).toBe('missing')
    expect(runProcess).not.toHaveBeenCalled()
    runProcess.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    expect((await readCodexCliInstallation({ program })).status).toBe('unknown')
    runProcess.mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'EACCES' }))
    expect((await readCodexCliInstallation({ program: await binary() })).status).toBe('unknown')
  })

  it('isolates hosts and does not let a slow old fingerprint replace a new verdict', async () => {
    const cache = new CodexCliInstallationCache()
    let finish: ((result: ReturnType<typeof codexCliInstallation>) => void) | undefined
    const stale = cache.read(
      'wsl:A',
      'old',
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const fresh = vi.fn(async () => codexCliInstallation(true, '0.136.0'))
    await cache.read('wsl:A', 'new', fresh)
    finish?.(codexCliInstallation(true, '0.135.0'))
    await stale
    expect((await cache.read('wsl:A', 'new', fresh)).status).toBe('ready')
    await cache.read('wsl:B', 'new', fresh)
    await cache.read('ssh:A', 'new', fresh)
    expect(fresh).toHaveBeenCalledTimes(3)
  })
})
