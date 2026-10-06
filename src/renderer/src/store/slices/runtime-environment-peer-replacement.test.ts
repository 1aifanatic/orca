import { describe, expect, it } from 'vitest'
import {
  peerReplacedEnvironmentIds,
  replacedRuntimeEnvironmentIds
} from './runtime-environment-peer-replacement'

function managed(
  overrides: { generation?: number; pairingRevision?: number; hostKey?: string | null } = {}
) {
  return {
    id: 'env-1',
    createdAt: 1,
    pairingRevision: overrides.pairingRevision ?? 1,
    ...(overrides.hostKey === null ? {} : { hostKeyFingerprint: overrides.hostKey ?? 'key-a' }),
    orcadDeployment: {
      sshTargetId: 'box',
      sshTargetGeneration: overrides.generation ?? 1,
      localPort: 46_768,
      remotePort: 6_768
    }
  }
}

function retired(previous: ReturnType<typeof managed>, next: ReturnType<typeof managed>): string[] {
  return peerReplacedEnvironmentIds(
    [previous],
    [next],
    replacedRuntimeEnvironmentIds([previous], [next])
  )
}

describe('which re-paired environments name a different machine', () => {
  it('keeps a managed server whose update re-paired it with the same proven host key', () => {
    expect(retired(managed(), managed({ pairingRevision: 2 }))).toEqual([])
  })

  it('retires the same target registration when the host proves a different key', () => {
    expect(retired(managed(), managed({ pairingRevision: 2, hostKey: 'key-reinstalled' }))).toEqual(
      ['env-1']
    )
  })

  it('retires a re-pair whose host key is unknown', () => {
    expect(
      retired(managed({ hostKey: null }), managed({ pairingRevision: 2, hostKey: null }))
    ).toEqual(['env-1'])
  })

  it('retires a managed server re-created for a new host registration', () => {
    expect(retired(managed(), managed({ generation: 2, pairingRevision: 2 }))).toEqual(['env-1'])
  })

  it('retires a re-paired environment that is not a managed server', () => {
    const paired = { id: 'env-1', createdAt: 1, pairingRevision: 1, hostKeyFingerprint: 'k' }
    expect(
      peerReplacedEnvironmentIds([paired], [{ ...paired, pairingRevision: 2 }], ['env-1'])
    ).toEqual(['env-1'])
  })

  it('leaves an environment alone while its pairing is unchanged', () => {
    expect(replacedRuntimeEnvironmentIds([managed()], [managed()])).toEqual([])
  })
})
