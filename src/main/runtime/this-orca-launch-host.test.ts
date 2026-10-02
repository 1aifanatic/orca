import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachedPwshAvailability } from '../pwsh'
import { thisOrcaLaunchHost } from './this-orca-launch-host'

vi.mock('../pwsh', () => ({ cachedPwshAvailability: vi.fn(() => null) }))

const realPlatform = process.platform

function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

// Why: this Orca spawns its own Windows panes, so it knows the PowerShell that gets the line.
describe('the PowerShell a launch this Orca runs lands in', () => {
  afterEach(() => {
    onPlatform(realPlatform)
    vi.mocked(cachedPwshAvailability).mockReturnValue(null)
  })

  it('follows the requested shell, then the settings and the pwsh probe, on this Windows machine', () => {
    onPlatform('win32')
    const settings = {
      terminalWindowsShell: 'powershell.exe',
      terminalWindowsPowerShellImplementation: 'auto' as const
    }
    const host = (windowsShellOverride?: string) =>
      thisOrcaLaunchHost({
        launchPlatform: 'win32',
        isRemote: false,
        settings,
        windowsShellOverride
      })
    expect(host().windowsPaneShell).toBeNull()
    vi.mocked(cachedPwshAvailability).mockReturnValue(false)
    expect(host().windowsPaneShell).toBe('powershell.exe')
    expect(host('pwsh.exe').windowsPaneShell).toBe('pwsh.exe')
    expect(
      thisOrcaLaunchHost({ launchPlatform: 'win32', isRemote: true, settings }).windowsPaneShell
    ).toBeNull()
  })

  it('knows none for a launch on another platform', () => {
    onPlatform('darwin')
    vi.mocked(cachedPwshAvailability).mockReturnValue(true)
    expect(
      thisOrcaLaunchHost({
        launchPlatform: 'win32',
        isRemote: false,
        settings: { terminalWindowsShell: 'pwsh.exe' }
      }).windowsPaneShell
    ).toBeNull()
  })
})
