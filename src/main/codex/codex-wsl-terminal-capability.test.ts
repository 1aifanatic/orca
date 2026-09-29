import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { runProcess, supports, probes } = vi.hoisted(() => ({
  runProcess: vi.fn(),
  supports: vi.fn(),
  probes: new Array<(path: string, invokedPath: string) => Promise<string>>()
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess }))
vi.mock('../wsl/wsl-executable-path', () => ({
  resolveWslExecutablePath: () => 'C:\\Windows\\System32\\wsl.exe'
}))
vi.mock('../../shared/codex-executable-capability', () => ({
  CodexExecutableCapability: class {
    constructor(probe: (path: string, invokedPath: string) => Promise<string>) {
      probes.push(probe)
    }
    supportsNoDaemon = supports
  }
}))
import { supportsWslCodexNoDaemon } from './codex-wsl-terminal-capability'

beforeEach(() => {
  supports.mockReset().mockResolvedValue(true)
  runProcess
    .mockReset()
    .mockResolvedValue({ code: 0, timedOut: false, stdout: 'codex-cli 0.156.0\n' })
})
afterEach(() => vi.unstubAllGlobals())

describe('WSL Codex capability scope', () => {
  it('uses a separate filesystem identity for each distro', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    expect(await supportsWslCodexNoDaemon('/opt/codex', 'Ubuntu')).toBe(true)
    expect(await supportsWslCodexNoDaemon('/opt/codex', 'Debian')).toBe(true)
    expect(supports.mock.calls).toEqual([
      ['\\\\wsl.localhost\\Ubuntu\\opt\\codex'],
      ['\\\\wsl.localhost\\Debian\\opt\\codex']
    ])
  })
  it('runs the named guest executable through --exec with its launcher directory on PATH', async () => {
    expect(
      await probes[0](
        '\\\\wsl.localhost\\Ubuntu\\pkg\\codex\\bin\\codex.js',
        '\\\\wsl.localhost\\Ubuntu\\home\\u\\.nvm\\bin\\codex'
      )
    ).toBe('codex-cli 0.156.0')
    expect(runProcess).toHaveBeenCalledExactlyOnceWith({
      program: 'C:\\Windows\\System32\\wsl.exe',
      args: [
        '-d',
        'Ubuntu',
        '--exec',
        '/usr/bin/env',
        'PATH=/home/u/.nvm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        '/pkg/codex/bin/codex.js',
        '--version'
      ],
      timeoutMs: 5_000,
      maxOutputBytes: 4_096
    })
  })
  it('rejects unavailable guests, malformed paths, and incompatible hosts', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    expect(await supportsWslCodexNoDaemon('/opt/codex', 'Ubuntu')).toBe(false)
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    expect(await supportsWslCodexNoDaemon('codex', 'Ubuntu')).toBe(false)
    expect(await supportsWslCodexNoDaemon('/opt/codex', 'bad/distro')).toBe(false)
    expect(supports).not.toHaveBeenCalled()
    expect(await probes[0]('C:\\codex.exe', 'C:\\codex.exe')).toBe('')
    expect(runProcess).not.toHaveBeenCalled()
  })
})
