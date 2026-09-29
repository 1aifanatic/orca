import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnBunPty } from './bun-pty-process'
import type { BunRuntime, BunSubprocess, BunTerminal } from './bun-pty-process-contract'
import type { PreparedWindowsBunPtyJob, WindowsBunPtyJob } from './windows-bun-pty-job'

function createHarness(spawnError?: Error) {
  const terminal: BunTerminal = {
    closed: false,
    write: vi.fn(() => 1),
    resize: vi.fn(),
    close: vi.fn(() => {
      terminal.closed = true
    })
  }
  const kill = vi.fn()
  const processHandle: BunSubprocess = {
    pid: 4321,
    terminal,
    kill,
    exited: new Promise<number>(() => {})
  }
  const spawn = vi.fn(
    (_command: string[], _options: Parameters<BunRuntime['spawn']>[1]): BunSubprocess => {
      if (spawnError) {
        throw spawnError
      }
      return processHandle
    }
  )
  const runtime: BunRuntime = {
    Terminal: class {
      closed = false
      write = terminal.write
      resize = terminal.resize
      close = terminal.close
      constructor() {
        return terminal
      }
    },
    spawn
  }
  const job: WindowsBunPtyJob = {
    listProcessIds: vi.fn(() => [4321]),
    pause: vi.fn(() => true),
    resume: vi.fn(() => true),
    terminate: vi.fn(() => 'terminated' as const),
    close: vi.fn()
  }
  const prepared = {
    handleValue: 0x2c4,
    adopt: vi.fn((_pid: number): WindowsBunPtyJob | null => job),
    discard: vi.fn()
  }
  const prepareJob = vi.fn((): PreparedWindowsBunPtyJob | null => prepared)
  const createWindowsLaunch = vi.fn()
  const createJob = vi.fn()
  const start = (file = 'pwsh.exe', args = ['-NoLogo'], killOnClose = true) =>
    spawnBunPty(
      {
        file,
        args,
        cwd: 'C:\\work',
        env: { TERM: 'xterm-256color', NODE_OPTIONS: '--inspect=0' },
        cols: 80,
        rows: 24,
        windowsJobKillOnClose: killOnClose
      },
      {
        platform: 'win32',
        runtime,
        assignHostJob: () => true,
        supportsDirectJobSpawn: () => true,
        prepareJob,
        createWindowsLaunch,
        createJob
      }
    )
  return { terminal, kill, spawn, job, prepared, prepareJob, createWindowsLaunch, createJob, start }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Windows direct job spawn (no resident gate)', () => {
  it('creates the shell inside a job prepared before spawn', async () => {
    const h = createHarness()
    const proc = h.start()

    expect(h.prepareJob).toHaveBeenCalledWith(undefined, true)
    expect(h.prepareJob.mock.invocationCallOrder[0]).toBeLessThan(
      h.spawn.mock.invocationCallOrder[0]
    )
    expect(h.spawn.mock.calls[0]?.[0]).toEqual(['pwsh.exe', '-NoLogo'])
    expect(h.spawn.mock.calls[0]?.[1]).toMatchObject({
      windowsJob: 0x2c4,
      windowsVerbatimArguments: false,
      // The gate stripped runtime options only from its own process; the shell keeps them.
      env: { TERM: 'xterm-256color', NODE_OPTIONS: '--inspect=0' }
    })
    expect(h.prepared.adopt).toHaveBeenCalledWith(4321)
    expect(h.createWindowsLaunch).not.toHaveBeenCalled()
    expect(h.createJob).not.toHaveBeenCalled()
    expect(proc.jobRootProcessIsWrapper).toBeUndefined()
    expect(proc.shellProcessId).toBe(4321)
    await proc.waitForSpawn?.()
    expect(proc.listOwnedProcessIds?.()).toEqual([4321])
    proc.destroy()
  })

  it('passes cmd.exe arguments verbatim', () => {
    const h = createHarness()
    h.start('C:\\Windows\\System32\\cmd.exe', ['/d', '/k'])
    expect(h.spawn.mock.calls[0]?.[1]).toMatchObject({ windowsVerbatimArguments: true })
  })

  it('refuses a shell the runtime did not create inside the job', () => {
    const h = createHarness()
    h.prepared.adopt.mockReturnValue(null)
    expect(() => h.start()).toThrow('Windows Bun PTY job ownership is unavailable')
    expect(h.kill).toHaveBeenCalled()
    expect(h.terminal.closed).toBe(true)
  })

  it('discards the prepared job when spawn fails', () => {
    const h = createHarness(new Error('spawn failed'))
    expect(() => h.start()).toThrow('spawn failed')
    expect(h.prepared.discard).toHaveBeenCalledOnce()
  })

  it('fails closed before spawning when no job can be prepared', () => {
    const h = createHarness()
    h.prepareJob.mockReturnValue(null)
    expect(() => h.start()).toThrow('Windows Bun PTY job ownership is unavailable')
    expect(h.spawn).not.toHaveBeenCalled()
  })
})
