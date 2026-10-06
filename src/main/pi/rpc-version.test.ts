import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { probePiRpcVersion, supportsPiRpcVersion } from './rpc-version'

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))

beforeEach(() => {
  vi.mocked(runProcess).mockReset()
})

describe('Pi RPC version support', () => {
  it.each(['1.0.0', '1.0.4\n', 'pi v1.12.3+build.1'])(
    'accepts the stable 1.x line: %s',
    (output) => {
      expect(supportsPiRpcVersion(output)).toBe(true)
    }
  )

  it.each(['0.73.1', '0.99.0', '1.0.0-rc.1', '1.1.0-preview.1', '2.0.0', 'unknown', ''])(
    'withholds structured chat for an unsupported or unknown version: %s',
    (output) => {
      expect(supportsPiRpcVersion(output)).toBe(false)
    }
  )

  it('bounds the version command and probes the selected execution-host binary and environment', async () => {
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      timedOut: false,
      stdout: '1.0.4\n',
      stderr: ''
    })
    const input = { program: '/host/bin/pi', cwd: '/host/workspace', env: { PATH: '/host/bin' } }
    await expect(probePiRpcVersion(input)).resolves.toBe(true)
    expect(runProcess).toHaveBeenCalledWith({
      ...input,
      args: ['--version'],
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      killOnOutputLimit: true
    })
  })

  it.each([
    { code: 1, timedOut: false, outputTruncated: false },
    { code: 0, timedOut: true, outputTruncated: false },
    { code: 0, timedOut: false, outputTruncated: true }
  ])('does not infer support from incomplete or failed output: %j', async (result) => {
    vi.mocked(runProcess).mockResolvedValue({
      ...result,
      signal: null,
      stdout: '1.0.4',
      stderr: ''
    })
    await expect(probePiRpcVersion({ program: '/host/bin/pi' })).resolves.toBe(false)
  })

  it('fails closed when the command cannot start', async () => {
    vi.mocked(runProcess).mockRejectedValue(new Error('ENOENT'))
    await expect(probePiRpcVersion({ program: '/host/bin/pi' })).resolves.toBe(false)
  })
})
