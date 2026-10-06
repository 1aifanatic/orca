import { describe, expect, it } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { peerReplacedEnvironmentIds } from './runtime-environment-peer-replacement'

function managed(
  generation: number,
  pairingRevision: number
): Pick<PublicKnownRuntimeEnvironment, 'id' | 'orcadDeployment' | 'pairingRevision'> {
  return {
    id: 'env-1',
    pairingRevision,
    orcadDeployment: {
      sshTargetId: 'box',
      sshTargetGeneration: generation,
      localPort: 46_768,
      remotePort: 6_768
    }
  }
}

describe('which re-paired environments name a different peer', () => {
  it('keeps a managed server that re-paired on update as the same peer', () => {
    expect(peerReplacedEnvironmentIds([managed(1, 1)], [managed(1, 2)], ['env-1'])).toEqual([])
  })

  it('retires a managed server re-created for a new host registration', () => {
    expect(peerReplacedEnvironmentIds([managed(1, 1)], [managed(2, 2)], ['env-1'])).toEqual([
      'env-1'
    ])
  })

  it('retires a re-paired environment that is not a managed server', () => {
    const paired = { id: 'env-1' }
    expect(peerReplacedEnvironmentIds([paired], [paired], ['env-1'])).toEqual(['env-1'])
  })
})
