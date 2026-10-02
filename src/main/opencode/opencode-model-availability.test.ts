import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { probeOpenCodeModelAvailability } from './opencode-model-availability'
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))
vi.mock('../ipc/command-path-resolver', () => ({ resolveCommandOnLocalPath: vi.fn() }))
const options = {
  command: '/private/opencode',
  model: 'opencode/fledge-alpha-free',
  cwd: '/tmp/project',
  env: { OPENCODE_CONFIG_DIR: '/private/config', XDG_DATA_HOME: '/private/account' }
}
describe('OpenCode model catalog validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveCommandOnLocalPath).mockResolvedValue('/resolved/opencode')
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      timedOut: false,
      stdout: 'opencode/fledge-alpha-free\nopencode/big-pickle\n',
      stderr: '',
      signal: null
    })
  })
  it('checks exact catalog membership using the execution scope', async () => {
    expect(await probeOpenCodeModelAvailability(options)).toBe(true)
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/resolved/opencode',
        args: ['models'],
        cwd: options.cwd,
        env: options.env
      })
    )
  })
  it('rejects the real invalid selector that falls back to Big Pickle', async () => {
    expect(await probeOpenCodeModelAvailability({ ...options, model: 'gpt-5-nano' })).toBe(false)
  })
  it('does not accept substrings or verbose metadata', async () => {
    expect(await probeOpenCodeModelAvailability({ ...options, model: 'fledge-alpha-free' })).toBe(
      false
    )
  })
  it('refuses timed out catalog probes even with matching partial output', async () => {
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      timedOut: true,
      stdout: options.model,
      stderr: '',
      signal: null
    })
    expect(await probeOpenCodeModelAvailability(options)).toBe(false)
  })
  it.each(['opencode', '/private/opencode --config another-profile', 'echo;/private/opencode'])(
    'refuses an executable or configuration that differs from the direct launch: %s',
    async (command) => {
      expect(await probeOpenCodeModelAvailability({ ...options, command })).toBe(false)
      expect(runProcess).not.toHaveBeenCalled()
    }
  )
  it('refuses WSL until its exact guest launch environment is available', async () => {
    expect(await probeOpenCodeModelAvailability({ ...options, wsl: { distro: 'Ubuntu' } })).toBe(
      false
    )
    expect(runProcess).not.toHaveBeenCalled()
  })
})
