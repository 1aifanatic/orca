import { describe, expect, it } from 'vitest'
import { NODE_RUNTIME_ASSETS, NODE_RUNTIME_COMPAT_ASSETS } from '../../shared/node-runtime-pin'
import {
  compatRelayRuntimeFor,
  pinnedRuntimeTargetForHost,
  relayRuntimeLadder,
  relayRuntimeStepAfterRefusal,
  relayRuntimeStorePins,
  remoteRuntimeUnavailableMessage,
  remoteRuntimeUnavailableReason,
  rungBCompatRuntimeFor
} from './ssh-relay-runtime-ladder'
import { resolveSshRemoteRuntime } from './ssh-relay-pinned-node'

const COMPAT_SHA = NODE_RUNTIME_COMPAT_ASSETS['linux-x64-glibc217'].executableSha256

describe('relay runtime ladder (design D6)', () => {
  it('keeps the host-npm path alone for Host Node, and before D in the Auto ladder', () => {
    const auto = ['A', 'B', 'C', 'legacy', 'D']
    expect(relayRuntimeLadder('legacy')).toEqual(['legacy'])
    expect(relayRuntimeLadder('pinned-node')).toEqual(auto)
    expect(relayRuntimeLadder(resolveSshRemoteRuntime(undefined, {}))).toEqual(auto)
  })

  it('steps to the next rung on an ordinary refusal', () => {
    const ladder = relayRuntimeLadder('pinned-node')
    expect(relayRuntimeStepAfterRefusal(ladder, 'A', 'libc_floor', false)).toBe('B')
    expect(relayRuntimeStepAfterRefusal(ladder, 'B', 'runtime_unavailable', false)).toBe('C')
  })

  it('walks a Windows host from a refused A through B and C, which refuse there, to host Node', () => {
    const ladder = relayRuntimeLadder('pinned-node')
    expect(relayRuntimeStepAfterRefusal(ladder, 'A', 'security_software', false)).toBe('B')
    expect(relayRuntimeStepAfterRefusal(ladder, 'A', 'missing_lib', true)).toBe('B')
    expect(relayRuntimeStepAfterRefusal(ladder, 'B', 'runtime_unavailable', false)).toBe('C')
    expect(relayRuntimeStepAfterRefusal(ladder, 'C', 'windows_host_unsupported', false)).toBe(
      'legacy'
    )
  })

  it('lets a remembered noexec skip only its own rung, so a remounted home is re-proved', () => {
    const ladder = relayRuntimeLadder('pinned-node')
    expect(relayRuntimeStepAfterRefusal(ladder, 'A', 'noexec', true)).toBe('B')
  })

  it('falls back past a refused ladder to host Node, and to D only on proof', () => {
    const ladder = relayRuntimeLadder('pinned-node')
    expect(relayRuntimeStepAfterRefusal(ladder, 'A', 'artifacts_unavailable', false)).toBe('B')
    for (const reason of [
      'artifacts_unavailable',
      'host_node_missing',
      'libc_floor',
      'target_unresolved'
    ] as const) {
      expect(relayRuntimeStepAfterRefusal(ladder, 'C', reason, false)).toBe('legacy')
    }
    // A noexec skips B and C (same tree) but still gets the fallback: exec denial can be per binary.
    expect(relayRuntimeStepAfterRefusal(ladder, 'C', 'noexec', false)).toBe('legacy')
    expect(relayRuntimeStepAfterRefusal(ladder, 'A', 'noexec', false)).toBe('legacy')
    expect(relayRuntimeStepAfterRefusal(ladder, 'A', 'install_failed', false)).toBe('B')
    // Only the fallback itself proving no host Node lands on D.
    for (const reason of ['host_node_missing', 'install_failed', 'noexec'] as const) {
      expect(relayRuntimeStepAfterRefusal(ladder, 'legacy', reason, false)).toBe('D')
    }
  })

  it('chooses rung B only when a listed compat runtime serves the host', () => {
    const facts = { target: 'linux-x64-glibc' as const, glibc: { major: 2, minor: 17 } }
    expect(compatRelayRuntimeFor(facts, [])).toBeNull()
    const catalog = [
      {
        id: 'glibc217',
        runtimeTarget: 'linux-x64-glibc217' as const,
        hostTarget: 'linux-x64-glibc' as const,
        glibcFloor: { major: 2, minor: 17 }
      }
    ]
    expect(compatRelayRuntimeFor(facts, catalog)?.id).toBe('glibc217')
    expect(compatRelayRuntimeFor({ ...facts, glibc: { major: 2, minor: 12 } }, catalog)).toBeNull()
    expect(compatRelayRuntimeFor({ target: 'linux-x64-musl', glibc: null }, catalog)).toBeNull()
    const muslCatalog = [
      {
        id: 'musl',
        runtimeTarget: 'linux-x64-glibc217' as const,
        hostTarget: 'linux-x64-musl' as const,
        glibcFloor: null
      }
    ]
    expect(compatRelayRuntimeFor({ target: 'linux-x64-musl', glibc: null }, muslCatalog)?.id).toBe(
      'musl'
    )
  })

  it('ships the glibc 2.17 compat runtime for linux-x64 hosts', () => {
    const facts = { target: 'linux-x64-glibc' as const, glibc: { major: 2, minor: 17 } }
    expect(compatRelayRuntimeFor(facts)?.runtimeTarget).toBe('linux-x64-glibc217')
    expect(compatRelayRuntimeFor({ target: 'linux-arm64-glibc', glibc: facts.glibc })).toBeNull()
  })

  it('runs rung B below 2.28, or on a newer glibc only after A refused over a library', () => {
    const old = { target: 'linux-x64-glibc' as const, glibc: { major: 2, minor: 27 } }
    const current = { target: 'linux-x64-glibc' as const, glibc: { major: 2, minor: 31 } }
    expect(rungBCompatRuntimeFor(old, 'libc_floor')?.id).toBe('glibc217')
    expect(rungBCompatRuntimeFor(old, null)?.id).toBe('glibc217')
    expect(rungBCompatRuntimeFor(current, 'missing_lib')?.id).toBe('glibc217')
    expect(rungBCompatRuntimeFor(current, 'libc_floor')?.id).toBe('glibc217')
    expect(rungBCompatRuntimeFor(current, 'illegal_instruction')).toBeNull()
    expect(rungBCompatRuntimeFor(current, 'artifacts_unavailable')).toBeNull()
    expect(
      rungBCompatRuntimeFor({ ...old, glibc: { major: 2, minor: 12 } }, 'libc_floor')
    ).toBeNull()
  })

  it('keeps the compat runtime pinned in the store beside the default one', () => {
    const defaultSha = NODE_RUNTIME_ASSETS['linux-x64-glibc'].executableSha256
    expect(relayRuntimeStorePins('linux-x64-glibc')).toEqual([defaultSha, COMPAT_SHA])
    expect(relayRuntimeStorePins('linux-x64-glibc217')).toEqual([defaultSha, COMPAT_SHA])
    expect(relayRuntimeStorePins('linux-arm64-glibc')).toEqual([
      NODE_RUNTIME_ASSETS['linux-arm64-glibc'].executableSha256
    ])
  })

  it('names the runtime a companion can run by glibc alone', () => {
    expect(
      pinnedRuntimeTargetForHost({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 28 } })
    ).toBe('linux-x64-glibc')
    expect(
      pinnedRuntimeTargetForHost({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 17 } })
    ).toBe('linux-x64-glibc217')
    expect(
      pinnedRuntimeTargetForHost({ target: 'linux-arm64-glibc', glibc: { major: 2, minor: 17 } })
    ).toBeNull()
    expect(pinnedRuntimeTargetForHost({ target: 'linux-x64-musl', glibc: null })).toBe(
      'linux-x64-musl'
    )
  })

  it('names the rung D reason in words the user can act on', () => {
    expect(remoteRuntimeUnavailableReason('noexec')).toBe('home_noexec')
    expect(remoteRuntimeUnavailableReason('host_node_missing')).toBe('no_runtime')
    expect(remoteRuntimeUnavailableMessage('home_noexec', 'noexec')).toContain('mounted noexec')
    expect(remoteRuntimeUnavailableMessage('no_runtime', 'host_node_missing')).toContain(
      'Install Node.js 18+'
    )
    expect(
      remoteRuntimeUnavailableMessage('no_runtime', 'missing_lib', false, 'host_node_missing')
    ).toContain('Install Node.js 18+')
  })

  it('offers Host Node only as an unsupported opt-in, and only when the host Node refused', () => {
    const message = remoteRuntimeUnavailableMessage(
      'no_runtime',
      'libc_floor',
      false,
      'missing_lib'
    )
    expect(message).toContain("set this host's Runtime to Host Node")
    expect(message).toContain('unsupported configuration')
    expect(message).toContain("Orca's Node: libc_floor; host Node: missing_lib")
    expect(message).not.toContain('Install Node.js')
  })

  it.each(['artifacts_unavailable', 'target_unresolved', 'windows_host_unsupported'] as const)(
    'never points at Host Node when rung C refused for %s',
    (hostNodeRefusal) => {
      const message = remoteRuntimeUnavailableMessage(
        'no_runtime',
        'security_software',
        false,
        hostNodeRefusal
      )
      expect(message).not.toContain('Host Node')
      expect(message).not.toContain('Install Node.js')
      expect(message).toContain(`host Node: ${hostNodeRefusal}`)
    }
  )

  it('never advises installing Node when a remembered noexec defeated the tree', () => {
    expect(remoteRuntimeUnavailableReason('host_node_missing', true)).toBe('home_noexec')
    const message = remoteRuntimeUnavailableMessage('home_noexec', 'noexec', true)
    expect(message).toContain('earlier connect found the home directory')
    expect(message).not.toContain('Install Node.js')
  })

  it('words a Windows rung D for Windows, offering Host Node rather than a noexec mount', () => {
    expect(remoteRuntimeUnavailableReason('noexec', false, 'win32')).toBe('no_runtime')
    const message = remoteRuntimeUnavailableMessage(
      'no_runtime',
      'noexec',
      false,
      'windows_host_unsupported',
      'win32'
    )
    expect(message).toContain('Windows host')
    expect(message).toContain("set this host's Runtime to Host Node")
    expect(message).not.toContain('noexec,')
    expect(message).not.toContain('mounted')
    expect(message).not.toContain('~/.orca-remote')
  })
})
