import { describe, expect, it } from 'vitest'
import { describeLaunchHost } from './launch-host'

describe('what a launch host can do with its prompt', () => {
  it.each([
    ['a local macOS host', false, false, 'darwin', 'darwin', true, true],
    ['a local Linux host', false, false, 'linux', 'linux', true, true],
    ['a local Windows host', false, false, 'win32', 'win32', false, true],
    // The pane runs in the distro, but the reads run on the Windows host; Orca writes into the distro.
    ['a local WSL pane', false, false, 'linux', 'win32', false, true],
    ['an SSH Linux host from Windows', true, false, 'linux', 'win32', true, true],
    // Its relay may run panes in WSL, where it writes no launch file; this client cannot tell.
    ['an SSH Windows host', true, false, 'win32', 'darwin', false, false],
    ['a paired Linux Orca from Windows', false, true, 'linux', 'win32', true, false],
    ['a paired Windows Orca from macOS', false, true, 'win32', 'darwin', false, false]
  ] as const)(
    '%s',
    (_label, isRemote, paired, launchPlatform, hostPlatform, proves, takesLaunchFile) => {
      expect(describeLaunchHost({ isRemote, paired, launchPlatform, hostPlatform })).toEqual({
        paired,
        provesAgentInFront: proves,
        takesLaunchFile
      })
    }
  )
})
