import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserClientHostLeaseAuthority } from '../../shared/browser-client-host-protocol'
import { BrowserClientHostParking, releaseBrowserClientGuests } from './browser-client-host-parking'

const authority: BrowserClientHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'client-a',
  browserHostGeneration: 2
}

function createOwner() {
  const order: string[] = []
  const attaches: { resolve(): void; reject(error: Error): void }[] = []
  const owner = {
    closed: false,
    isClosed: () => owner.closed,
    retireLease: vi.fn(async (_input: string, _error: Error, releaseGuests: boolean) => {
      order.push(releaseGuests ? 'retire-lease+release-guests' : 'retire-lease')
    }),
    attach: vi.fn(
      (input: string) =>
        new Promise<BrowserClientHostLeaseAuthority>((resolve, reject) => {
          order.push(`attach:${input}`)
          attaches.push({ resolve: () => resolve(authority), reject })
        })
    ),
    suspend: vi.fn(() => {
      order.push('suspend')
    }),
    releaseGuests: vi.fn(async () => {
      order.push('release-guests')
    })
  }
  return { owner, order, attaches }
}

async function settleAttach(rig: ReturnType<typeof createOwner>, index = 0): Promise<void> {
  await vi.waitFor(() => expect(rig.attaches[index]).toBeDefined())
  rig.attaches[index]!.resolve()
}

describe('BrowserClientHostParking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('suspends the lease on every loss but arms one memory discard', () => {
    const rig = createOwner()
    const parking = new BrowserClientHostParking('input-a', rig.owner, 1_000)

    parking.park(new Error('grace expired'))
    parking.park(new Error('grace expired again'))
    vi.advanceTimersByTime(999)
    expect(rig.owner.releaseGuests).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(rig.order).toEqual(['suspend', 'suspend', 'release-guests'])
    // Freeing memory decides nothing: the state stays parked, waiting for the host.
    expect(parking.isParked).toBe(true)
  })

  it('does nothing for a closed owner and leaves no timer after dispose', () => {
    const rig = createOwner()
    const parking = new BrowserClientHostParking('input-a', rig.owner, 1_000)

    parking.park(new Error('lost'))
    parking.dispose()
    rig.owner.closed = true
    parking.park(new Error('lost'))
    vi.advanceTimersByTime(10_000)

    expect(parking.isParked).toBe(false)
    expect(rig.owner.releaseGuests).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('answers a trigger only while parked, and shares one attempt between triggers', async () => {
    const rig = createOwner()
    const parking = new BrowserClientHostParking('input-a', rig.owner, 1_000)
    expect(parking.resume()).toBeNull()
    parking.park(new Error('lost'))
    parking.noteAuthority({ ...authority, returningHostReclaimProtocolVersion: 1 })

    const first = parking.resume()
    const second = parking.resume()
    expect(second).toBe(first)
    await settleAttach(rig)

    await expect(first).resolves.toEqual(authority)
    expect(rig.order).toEqual(['suspend', 'retire-lease', 'attach:input-a'])
    expect(parking.isParked).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(rig.owner.releaseGuests).not.toHaveBeenCalled()
  })

  it('frees kept guests before re-attaching to a runtime that cannot rekey them', async () => {
    const rig = createOwner()
    const parking = new BrowserClientHostParking('input-a', rig.owner, 1_000)
    parking.noteAuthority(authority)
    parking.park(new Error('lost'))

    const resumed = parking.resume()
    await settleAttach(rig)
    await resumed

    expect(rig.order).toEqual(['suspend', 'retire-lease+release-guests', 'attach:input-a'])
  })

  it('stays parked after a failed attempt, and the very next trigger tries again', async () => {
    const rig = createOwner()
    const parking = new BrowserClientHostParking('input-a', rig.owner, 1_000)
    parking.park(new Error('lost'))

    const failed = parking.resume()
    await vi.waitFor(() => expect(rig.attaches).toHaveLength(1))
    rig.attaches[0]!.reject(new Error('still unreachable'))
    await expect(failed).rejects.toThrow('still unreachable')
    expect(parking.isParked).toBe(true)

    const retried = parking.resume()
    expect(retried).not.toBe(failed)
    await settleAttach(rig, 1)
    await expect(retried).resolves.toEqual(authority)
  })

  it('runs a replacement runtime only after the attempt in flight settles', async () => {
    const rig = createOwner()
    const parking = new BrowserClientHostParking('input-a', rig.owner, 1_000)
    parking.park(new Error('lost'))

    const resumed = parking.resume()
    const replaced = parking.replace('input-b')
    await vi.waitFor(() => expect(rig.attaches).toHaveLength(1))
    expect(rig.order).not.toContain('attach:input-b')
    rig.attaches[0]!.reject(new Error('authority mismatch'))
    await expect(resumed).rejects.toThrow('authority mismatch')
    await settleAttach(rig, 1)

    await expect(replaced).resolves.toEqual(authority)
    expect(rig.order.at(-1)).toBe('attach:input-b')
  })
})

describe('releaseBrowserClientGuests', () => {
  it('retires every guest the executor still holds and reports every failure', async () => {
    const retirePage = vi.fn(async (browserPageId: string) => {
      if (browserPageId === 'page-b') {
        throw new Error('cleanup failed')
      }
      return true
    })
    const executor = {
      snapshotPageInventory: () => [
        { browserPageId: 'page-a', pageHostGeneration: 3 },
        { browserPageId: 'page-b', pageHostGeneration: 4 }
      ],
      retirePage
    }

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: release reads only id and generation.
    await expect(releaseBrowserClientGuests(executor as never)).rejects.toThrow(AggregateError)

    expect(retirePage).toHaveBeenCalledWith('page-a', 3)
    expect(retirePage).toHaveBeenCalledWith('page-b', 4)
  })
})
