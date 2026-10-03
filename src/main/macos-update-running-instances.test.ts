import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getMacUpdateRunningInstances,
  parseMacUpdateRunningInstances
} from './macos-update-running-instances'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))
vi.mock('../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

const executable = '/Applications/Orca Test.app/Contents/MacOS/Orca Test'

describe('macOS update running instances', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
  })

  it('finds sibling main processes while excluding self, helpers, unrelated commands and other app copies', () => {
    expect(
      parseMacUpdateRunningInstances(
        [
          ` 100 ${executable}`,
          ` 101 ${executable}`,
          ` 102 ${executable}`,
          ' 103 /Applications/Orca Test.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper',
          ' 104 /tmp/Orca Test.app/Contents/MacOS/Orca Test',
          ` 105 /bin/zsh -c ${executable}`,
          ' 106 /usr/bin/login',
          ''
        ].join('\n'),
        executable,
        100
      )
    ).toEqual([101, 102])
  })

  it('rejects malformed process output instead of assuming no blockers', () => {
    expect(() => parseMacUpdateRunningInstances('not a process row', executable, 100)).toThrow()
  })

  it('skips development runtimes without probing the host', async () => {
    expect(await getMacUpdateRunningInstances('/usr/local/bin/node')).toEqual([])
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it.each(['linux', 'win32'])('does not probe on %s', async (platform) => {
    vi.stubGlobal('process', { ...process, platform })
    try {
      expect(await getMacUpdateRunningInstances(executable)).toEqual([])
      expect(runProcessMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.runIf(process.platform === 'darwin')(
    'uses a bounded same-user process query and preserves paths with spaces',
    async () => {
      runProcessMock.mockResolvedValue({
        code: 0,
        stdout: `100 ${executable}\n101 ${executable}\n`,
        timedOut: false
      })
      expect(await getMacUpdateRunningInstances(executable, 100)).toEqual([101])
      expect(runProcessMock).toHaveBeenCalledWith(
        expect.objectContaining({
          program: '/bin/ps',
          args: ['-U', String(process.getuid?.()), '-ww', '-o', 'pid=,comm='],
          timeoutMs: 5000,
          killOnOutputLimit: true
        })
      )
    }
  )

  it.runIf(process.platform === 'darwin').each([
    { code: 1, timedOut: false },
    { code: null, timedOut: true },
    { code: 0, timedOut: false, outputTruncated: true }
  ])('fails closed for incomplete query results: %j', async (result) => {
    runProcessMock.mockResolvedValue({ stdout: '', ...result })
    await expect(getMacUpdateRunningInstances(executable)).rejects.toThrow('Could not check')
  })
})
