import { describe, expect, it } from 'vitest'
import { launchHostProvesAgentInFront } from './launch-host-agent-in-front'

describe('whether a launch host can prove its agent is in front before a paste', () => {
  it.each([
    ['a local macOS host', false, 'darwin', 'darwin', true],
    ['a local Linux host', false, 'linux', 'linux', true],
    ['a local Windows host', false, 'win32', 'win32', false],
    // The pane runs in the distro, but the reads run on the Windows host.
    ['a local WSL pane', false, 'linux', 'win32', false],
    ['an SSH Linux host from Windows', true, 'linux', 'win32', true],
    ['an SSH Windows host', true, 'win32', 'darwin', false]
  ] as const)('%s: %s', (_label, isRemote, launchPlatform, hostPlatform, proves) => {
    expect(launchHostProvesAgentInFront({ isRemote, launchPlatform, hostPlatform })).toBe(proves)
  })
})
