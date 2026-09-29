import { describe, expect, it, vi } from 'vitest'
import type { BunRuntime, BunSubprocess, BunTerminal } from './bun-pty-process-contract'
import { supportsWindowsDirectJobSpawn } from './windows-bun-direct-job-spawn'

function fakeTerminal(): BunTerminal {
  const terminal: BunTerminal = {
    closed: false,
    write: () => 0,
    resize: () => {},
    close: vi.fn(() => {
      terminal.closed = true
    })
  }
  return terminal
}

function runtimeWith(spawn: BunRuntime['spawn']): BunRuntime {
  return {
    Terminal: class {
      closed = false
      write = () => 0
      resize = () => {}
      close = () => {}
    },
    spawn
  }
}

describe('supportsWindowsDirectJobSpawn', () => {
  it('accepts a runtime that validates windowsJob before creating anything, once', () => {
    const spawn = vi.fn(
      (_command: string[], _options: Parameters<BunRuntime['spawn']>[1]): BunSubprocess => {
        throw new TypeError('windowsJob must be a positive integer handle')
      }
    )
    const runtime = runtimeWith(spawn)
    expect(supportsWindowsDirectJobSpawn(runtime)).toBe(true)
    expect(supportsWindowsDirectJobSpawn(runtime)).toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[1]).toMatchObject({ windowsJob: -1 })
  })

  it('rejects a stock runtime and cleans up the probe it spawned', () => {
    const terminal = fakeTerminal()
    const probe: BunSubprocess = { pid: 7, terminal, exited: Promise.resolve(0), kill: vi.fn() }
    const runtime = runtimeWith(vi.fn(() => probe))
    expect(supportsWindowsDirectJobSpawn(runtime)).toBe(false)
    expect(probe.kill).toHaveBeenCalledOnce()
    expect(terminal.close).toHaveBeenCalledOnce()
  })

  it('treats any other spawn failure as unsupported', () => {
    const runtime = runtimeWith(
      vi.fn(() => {
        throw new Error('ENOENT')
      })
    )
    expect(supportsWindowsDirectJobSpawn(runtime)).toBe(false)
  })
})
