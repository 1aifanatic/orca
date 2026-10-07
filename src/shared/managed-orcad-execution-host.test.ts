import { describe, expect, it } from 'vitest'
import { buildExecutionHostRegistry } from './execution-host-registry'
import { indexExecutionHostsById } from './managed-orcad-execution-host'
import type { SshConnectionState } from './ssh-types'

const SSH_TARGETS = new Map([['omarchy-target', 'Omarchy']])
const MANAGED_SERVER = {
  id: 'omarchy-server',
  name: 'Omarchy',
  orcadDeployment: { sshTargetId: 'omarchy-target' }
}

function connectionStates(
  managedServer: SshConnectionState['managedServer']
): Map<string, SshConnectionState> {
  return new Map([
    [
      'omarchy-target',
      {
        targetId: 'omarchy-target',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        managedServer
      }
    ]
  ])
}

function hostIdsAndLabels(
  hosts: ReturnType<typeof buildExecutionHostRegistry>
): [string, string][] {
  return hosts.map((host) => [host.id, host.label])
}

describe('managed Orca server host merging', () => {
  it('shows an SSH host and its managed server as one row routed to the server', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [],
      settings: null,
      hostSource: 'configured-only',
      sshTargetLabels: SSH_TARGETS,
      sshConnectionStates: connectionStates({ kind: 'managed', environmentId: 'omarchy-server' }),
      runtimeEnvironments: [MANAGED_SERVER]
    })

    expect(hostIdsAndLabels(hosts)).toEqual([
      ['local', expect.any(String)],
      ['runtime:omarchy-server', 'Omarchy']
    ])
    expect(hosts[1]).toMatchObject({
      kind: 'runtime',
      detail: 'SSH',
      aliasHostIds: ['ssh:omarchy-target']
    })
  })

  it('merges a disconnected managed host the same way, before main reports its route', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [],
      settings: null,
      sshTargetLabels: SSH_TARGETS,
      runtimeEnvironments: [MANAGED_SERVER]
    })

    expect(hosts.map((host) => host.id)).toEqual(['local', 'runtime:omarchy-server'])
  })

  it('keeps the SSH id when main reports the host on its relay', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [],
      settings: null,
      hostSource: 'configured-only',
      sshTargetLabels: SSH_TARGETS,
      sshConnectionStates: connectionStates({ kind: 'relay', reason: 'source_changed' }),
      runtimeEnvironments: [MANAGED_SERVER]
    })

    expect(hostIdsAndLabels(hosts)).toEqual([
      ['local', expect.any(String)],
      ['ssh:omarchy-target', 'Omarchy']
    ])
    expect(hosts[1]).toMatchObject({ kind: 'ssh', aliasHostIds: ['runtime:omarchy-server'] })
  })

  it('keeps a manually paired server that no SSH host deployed', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [],
      settings: null,
      hostSource: 'configured-only',
      sshTargetLabels: SSH_TARGETS,
      runtimeEnvironments: [{ id: 'paired-server', name: 'Omarchy' }]
    })

    expect(hosts.map((host) => host.id)).toEqual([
      'local',
      'runtime:paired-server',
      'ssh:omarchy-target'
    ])
  })

  it('keeps an orphaned managed server whose SSH host was removed', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [],
      settings: null,
      hostSource: 'configured-only',
      sshTargetLabels: new Map(),
      runtimeEnvironments: [MANAGED_SERVER]
    })

    expect(hostIdsAndLabels(hosts)).toEqual([
      ['local', expect.any(String)],
      ['runtime:omarchy-server', 'Omarchy']
    ])
    expect(hosts[1]?.aliasHostIds).toBeUndefined()
  })

  it('keeps the SSH row while workspaces still point at it, so they never lose their host', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [{ connectionId: 'omarchy-target' }],
      settings: null,
      sshTargetLabels: SSH_TARGETS,
      runtimeEnvironments: [MANAGED_SERVER]
    })

    expect(hosts.map((host) => host.id)).toEqual([
      'local',
      'runtime:omarchy-server',
      'ssh:omarchy-target'
    ])
    expect(hosts.find((host) => host.id === 'runtime:omarchy-server')?.aliasHostIds).toBeUndefined()
  })

  it('resolves a selection saved under either id to the one merged row', () => {
    const managed = indexExecutionHostsById(
      buildExecutionHostRegistry({
        repos: [],
        settings: null,
        hostSource: 'configured-only',
        sshTargetLabels: SSH_TARGETS,
        runtimeEnvironments: [MANAGED_SERVER]
      })
    )
    const relay = indexExecutionHostsById(
      buildExecutionHostRegistry({
        repos: [],
        settings: null,
        hostSource: 'configured-only',
        sshTargetLabels: SSH_TARGETS,
        sshConnectionStates: connectionStates({ kind: 'relay', reason: 'source_changed' }),
        runtimeEnvironments: [MANAGED_SERVER]
      })
    )

    expect(managed.get('runtime:omarchy-server')?.label).toBe('Omarchy')
    expect(managed.get('ssh:omarchy-target')?.id).toBe('runtime:omarchy-server')
    expect(relay.get('runtime:omarchy-server')?.id).toBe('ssh:omarchy-target')
    expect(relay.get('runtime:omarchy-server')?.label).toBe('Omarchy')
  })

  it('names the merged row with a rename saved on either id', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [],
      settings: null,
      hostSource: 'configured-only',
      sshTargetLabels: SSH_TARGETS,
      runtimeEnvironments: [MANAGED_SERVER],
      hostLabelOverrides: new Map([['ssh:omarchy-target', 'Build box']])
    })

    expect(hosts.find((host) => host.id === 'runtime:omarchy-server')?.label).toBe('Build box')
  })
})
