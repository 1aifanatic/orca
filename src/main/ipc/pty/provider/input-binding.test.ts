import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindProviderPtyInput } from './input-binding'
import { ptyIncarnationById, ptyOwnership } from './ownership-state'

const { provider } = vi.hoisted(() => ({ provider: { hasPty: vi.fn(() => true) } }))
vi.mock('./registry', () => ({ tryGetProviderForPty: () => provider }))
const PTY = 'input-binding-test'

afterEach(() => {
  ptyOwnership.delete(PTY)
  ptyIncarnationById.delete(PTY)
  provider.hasPty.mockReturnValue(true)
})

describe('provider input binding', () => {
  it('allows a known restored PTY before renderer ownership is populated', () => {
    const binding = bindProviderPtyInput(PTY)
    expect(binding.isCurrent()).toBe(true)
    provider.hasPty.mockReturnValue(false)
    expect(binding.isCurrent()).toBe(false)
  })

  it('fences retired ownership and gives reused IDs an independent incarnation key', () => {
    ptyOwnership.set(PTY, null)
    ptyIncarnationById.set(PTY, 'old')
    const old = bindProviderPtyInput(PTY)
    expect(old.isCurrent()).toBe(true)
    ptyOwnership.delete(PTY)
    expect(old.isCurrent()).toBe(false)
    ptyOwnership.set(PTY, null)
    ptyIncarnationById.set(PTY, 'new')
    const current = bindProviderPtyInput(PTY)
    expect(current.key).not.toBe(old.key)
    expect(current.isCurrent()).toBe(true)
    expect(old.isCurrent()).toBe(false)
  })
})
