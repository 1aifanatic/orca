import { describe, expect, it } from 'vitest'
import {
  peerReplacedEnvironmentIds,
  replacedRuntimeEnvironmentIds
} from './runtime-environment-peer-replacement'

function managed(
  overrides: { generation?: number; pairingRevision?: number; runtimeId?: string | null } = {}
) {
  return {
    id: 'env-1',
    createdAt: 1,
    pairingRevision: overrides.pairingRevision ?? 1,
    runtimeId: overrides.runtimeId === undefined ? 'orcad-a' : overrides.runtimeId,
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
  it('keeps a managed server whose update re-paired it with the same proven host identity', () => {
    expect(retired(managed(), managed({ pairingRevision: 2 }))).toEqual([])
  })

  it('retires the same target registration once its host proves a different identity', () => {
    expect(retired(managed(), managed({ runtimeId: 'orcad-reinstalled' }))).toEqual(['env-1'])
    expect(
      retired(managed(), managed({ pairingRevision: 2, runtimeId: 'orcad-reinstalled' }))
    ).toEqual(['env-1'])
  })

  it('retires a re-pair whose host identity was never proven', () => {
    expect(
      retired(managed({ runtimeId: null }), managed({ pairingRevision: 2, runtimeId: null }))
    ).toEqual(['env-1'])
  })

  it('retires a managed server re-created for a new host registration', () => {
    expect(retired(managed(), managed({ generation: 2, pairingRevision: 2 }))).toEqual(['env-1'])
  })

  it('retires a re-paired environment that is not a managed server', () => {
    const paired = { id: 'env-1', createdAt: 1, pairingRevision: 1, runtimeId: 'r' }
    expect(
      peerReplacedEnvironmentIds([paired], [{ ...paired, pairingRevision: 2 }], ['env-1'])
    ).toEqual(['env-1'])
  })

  it('treats a first recorded identity as a verification, not a new machine', () => {
    expect(replacedRuntimeEnvironmentIds([managed({ runtimeId: null })], [managed()])).toEqual([])
  })
})
