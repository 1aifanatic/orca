import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'

const { userInfoMock } = vi.hoisted(() => ({
  userInfoMock: vi.fn<() => { homedir: string }>()
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, userInfo: userInfoMock }
})

import { isSystemCodexHomeCodexDefault } from './codex-default-home'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

afterEach(() => {
  setPlatform(originalPlatform)
  vi.unstubAllEnvs()
  userInfoMock.mockReset()
})

describe('isSystemCodexHomeCodexDefault', () => {
  it('agrees on Linux unless HOME is set but empty', () => {
    setPlatform('linux')
    vi.stubEnv('HOME', '/home/user')
    expect(isSystemCodexHomeCodexDefault()).toBe(true)
    vi.stubEnv('HOME', undefined)
    expect(isSystemCodexHomeCodexDefault()).toBe(true)
    // Codex falls back to the passwd entry; Node's homedir() returns ''.
    vi.stubEnv('HOME', '')
    expect(isSystemCodexHomeCodexDefault()).toBe(false)
    expect(userInfoMock).not.toHaveBeenCalled()
  })

  it('agrees on macOS only when HOME is the account home that login(1) restores', () => {
    setPlatform('darwin')
    userInfoMock.mockReturnValue({ homedir: '/Users/neil' })
    vi.stubEnv('HOME', '/Users/neil/')
    expect(isSystemCodexHomeCodexDefault()).toBe(true)
    vi.stubEnv('HOME', undefined)
    expect(isSystemCodexHomeCodexDefault()).toBe(true)
    vi.stubEnv('HOME', '/tmp/rig/home')
    expect(isSystemCodexHomeCodexDefault()).toBe(false)
    vi.stubEnv('HOME', '')
    expect(isSystemCodexHomeCodexDefault()).toBe(false)
  })

  it('disagrees on macOS when the account home cannot be read', () => {
    setPlatform('darwin')
    userInfoMock.mockImplementation(() => {
      throw new Error('no passwd entry')
    })
    vi.stubEnv('HOME', '/Users/neil')
    expect(isSystemCodexHomeCodexDefault()).toBe(false)
  })

  it('agrees on Windows when USERPROFILE is unset or names the profile directory', () => {
    setPlatform('win32')
    userInfoMock.mockReturnValue({ homedir: 'C:\\Users\\neil' })
    vi.stubEnv('USERPROFILE', undefined)
    expect(isSystemCodexHomeCodexDefault()).toBe(true)
    vi.stubEnv('USERPROFILE', 'c:/users/NEIL/')
    expect(isSystemCodexHomeCodexDefault()).toBe(true)
  })

  it('disagrees on Windows when USERPROFILE points elsewhere', () => {
    setPlatform('win32')
    userInfoMock.mockReturnValue({ homedir: 'C:\\Users\\neil' })
    vi.stubEnv('USERPROFILE', 'C:\\Temp\\rig\\home')
    expect(isSystemCodexHomeCodexDefault()).toBe(false)
  })

  it('disagrees on Windows when the profile directory cannot be read', () => {
    setPlatform('win32')
    userInfoMock.mockImplementation(() => {
      throw new Error('no profile')
    })
    vi.stubEnv('USERPROFILE', 'C:\\Users\\neil')
    expect(isSystemCodexHomeCodexDefault()).toBe(false)
  })
})
