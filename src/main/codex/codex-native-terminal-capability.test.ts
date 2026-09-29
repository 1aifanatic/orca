import { beforeEach, describe, expect, it, vi } from 'vitest'
const { runProcess, resolvePowerShell } = vi.hoisted(() => ({
  runProcess: vi.fn(),
  resolvePowerShell: vi.fn()
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess }))
vi.mock('../providers/windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: resolvePowerShell
}))
import { probeCodexTerminalVersion } from './codex-native-terminal-capability'

beforeEach(() => {
  runProcess
    .mockReset()
    .mockResolvedValue({ code: 0, stdout: 'codex-cli 0.156.0\n', timedOut: false })
  resolvePowerShell
    .mockReset()
    .mockReturnValue('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
})

describe('Codex executable version probe', () => {
  it('probes the exact executable with its launcher directory on PATH and bounded output', async () => {
    expect(
      await probeCodexTerminalVersion('/pkg/codex/bin/codex.js', {
        invokedPath: '/home/u/.nvm/versions/node/v22/bin/codex',
        env: { PATH: '/usr/bin' },
        platform: 'linux'
      })
    ).toBe('codex-cli 0.156.0')
    expect(runProcess).toHaveBeenCalledExactlyOnceWith({
      program: '/pkg/codex/bin/codex.js',
      args: ['--version'],
      env: { PATH: '/home/u/.nvm/versions/node/v22/bin:/usr/bin' },
      timeoutMs: 5_000,
      maxOutputBytes: 4_096
    })
  })
  it('uses a hidden process and file argv for a Windows PowerShell launcher without bypassing policy', async () => {
    expect(
      await probeCodexTerminalVersion('C:\\agent dir\\codex.ps1', {
        env: { Path: 'C:\\Windows' },
        platform: 'win32'
      })
    ).toBe('codex-cli 0.156.0')
    expect(runProcess).toHaveBeenCalledExactlyOnceWith({
      program: resolvePowerShell(),
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        'C:\\agent dir\\codex.ps1',
        '--version'
      ],
      env: { Path: 'C:\\agent dir;C:\\Windows' },
      timeoutMs: 5_000,
      maxOutputBytes: 4_096
    })
  })
  it('retains the existing launch if an interpreter is unavailable', async () => {
    resolvePowerShell.mockReturnValue(null)
    expect(await probeCodexTerminalVersion('C:\\codex.ps1', { platform: 'win32' })).toBe('')
    expect(runProcess).not.toHaveBeenCalled()
  })
  it.each([
    { code: 1, timedOut: false },
    { code: 0, timedOut: true }
  ])('rejects incomplete version evidence: %j', async (result) => {
    runProcess.mockResolvedValue({ ...result, stdout: 'codex-cli 0.156.0' })
    expect(await probeCodexTerminalVersion('/custom/codex', { platform: 'linux' })).toBe('')
  })
})
