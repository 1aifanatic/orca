import { describe, expect, it } from 'vitest'
import type { SshTarget } from './ssh-types'
import { isFencedOrcadSourceSessionPartition } from './orcad-fenced-source-session'

function lookup(fence?: SshTarget['orcadFence']) {
  return (id: string) => (id === 'target-1' ? { orcadFence: fence } : undefined)
}

describe('isFencedOrcadSourceSessionPartition', () => {
  it('freezes a fenced host partition until an older build changes it', () => {
    expect(
      isFencedOrcadSourceSessionPartition(lookup({ environmentId: 'e' }), 'ssh:target-1')
    ).toBe(true)
    expect(
      isFencedOrcadSourceSessionPartition(
        lookup({ environmentId: 'e', sourceChangedAt: '2026-10-04T00:00:00.000Z' }),
        'ssh:target-1'
      )
    ).toBe(false)
  })

  it('leaves unfenced, unknown, local and runtime partitions writable', () => {
    const fenced = lookup({ environmentId: 'e' })
    expect(isFencedOrcadSourceSessionPartition(lookup(), 'ssh:target-1')).toBe(false)
    expect(isFencedOrcadSourceSessionPartition(fenced, 'ssh:target-2')).toBe(false)
    expect(isFencedOrcadSourceSessionPartition(fenced, undefined)).toBe(false)
    expect(isFencedOrcadSourceSessionPartition(fenced, 'local')).toBe(false)
    expect(isFencedOrcadSourceSessionPartition(fenced, 'runtime:target-1')).toBe(false)
  })
})
