import { afterEach, describe, expect, it, vi } from 'vitest'
import { runBundledBunFixture } from './bundled-bun-test-execution'

const { run, exists } = vi.hoisted(() => ({ run: vi.fn(), exists: vi.fn() }))
vi.mock('node:fs', () => ({ existsSync: exists }))
vi.mock('../shared/child-process/run-process', () => ({ runProcess: run }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('bundled Bun fixture launch environment', () => {
  it('removes runtime injection while retaining explicit fixture arguments and shell environment', async () => {
    exists.mockReturnValue(true)
    run.mockResolvedValue({
      code: 0,
      stdout: '"done"',
      stderr: '',
      timedOut: false,
      outputTruncated: false
    })
    for (const key of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'BUN_OPTIONS',
      'BUN_INSPECT',
      'BUN_INSPECT_WAIT'
    ]) {
      vi.stubEnv(key, 'injected-runtime-setting')
    }
    vi.stubEnv('SHELL', '/bin/zsh')
    const args = { env: { NODE_OPTIONS: '--fixture-shell-option' } }
    expect(await runBundledBunFixture('/fixture.ts', 'capture', args, 1000)).toBe('done')
    const spec = run.mock.calls[0][0]
    for (const key of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'BUN_OPTIONS',
      'BUN_INSPECT',
      'BUN_INSPECT_WAIT'
    ]) {
      expect(spec.env[key]).toBeUndefined()
    }
    expect(spec.env.SHELL).toBe('/bin/zsh')
    expect(spec.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
    expect(JSON.parse(spec.input)).toEqual(args)
  })
})
