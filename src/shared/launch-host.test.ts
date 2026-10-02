import { describe, expect, it } from 'vitest'
import { describeLaunchHost } from './launch-host'

describe('whether a launch host can prove its agent is in front before a paste', () => {
  it.each([
    ['a local macOS host', false, false, 'darwin', 'darwin', true],
    ['a local Linux host', false, false, 'linux', 'linux', true],
    ['a local Windows host', false, false, 'win32', 'win32', false],
    // The pane runs in the distro, but the reads run on the Windows host.
    ['a local WSL pane', false, false, 'linux', 'win32', false],
    ['an SSH Linux host from Windows', true, false, 'linux', 'win32', true],
    ['an SSH Windows host', true, false, 'win32', 'darwin', false],
    ['a paired Linux Orca from Windows', false, true, 'linux', 'win32', true],
    ['a paired Windows Orca from macOS', false, true, 'win32', 'darwin', false]
  ] as const)('%s', (_label, isRemote, paired, launchPlatform, hostPlatform, proves) => {
    expect(describeLaunchHost({ isRemote, paired, launchPlatform, hostPlatform })).toEqual({
      paired,
      provesAgentInFront: proves
    })
  })
})
