import { afterEach, describe, expect, it, vi } from 'vitest'

// Why a mocked removal: the property under test is the ORDER in which overlapping removals settle,
// which real filesystem timing cannot pin down. Deferreds make the interleaving exact.
const { removeHostTreeMock } = vi.hoisted(() => ({ removeHostTreeMock: vi.fn() }))
vi.mock('../host-tree-removal', () => ({ removeHostTree: removeHostTreeMock }))

const originalNoAsar = process.noAsar

afterEach(() => {
  process.noAsar = originalNoAsar
  vi.resetModules()
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('removeExtractedAppImagePayload reentrancy', () => {
  // The old hazard was a process-wide asar toggle handed back while a later removal still ran; the
  // shared removal holds no such flag, so overlapping removals must leave it untouched throughout.
  it('leaves asar interception untouched while overlapping removals settle', async () => {
    process.noAsar = false
    const first = deferred()
    const second = deferred()
    removeHostTreeMock.mockReset()
    removeHostTreeMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { removeExtractedAppImagePayload } = await import('./appimage-payload-removal')

    const firstCall = removeExtractedAppImagePayload('/cache/gen-a')
    const secondCall = removeExtractedAppImagePayload('/cache/gen-b')
    expect(removeHostTreeMock.mock.calls).toEqual([['/cache/gen-a'], ['/cache/gen-b']])
    expect(process.noAsar).toBe(false)

    first.resolve()
    await firstCall
    expect(process.noAsar).toBe(false)

    second.resolve()
    await secondCall
    expect(process.noAsar).toBe(false)
  })

  it('rejects only the failed removal when the first rejects mid-overlap', async () => {
    process.noAsar = false
    const second = deferred()
    removeHostTreeMock.mockReset()
    removeHostTreeMock
      .mockRejectedValueOnce(new Error('EACCES'))
      .mockReturnValueOnce(second.promise)
    const { removeExtractedAppImagePayload } = await import('./appimage-payload-removal')

    const firstCall = removeExtractedAppImagePayload('/cache/gen-a')
    const secondCall = removeExtractedAppImagePayload('/cache/gen-b')

    await expect(firstCall).rejects.toThrow('EACCES')
    expect(process.noAsar).toBe(false)

    second.resolve()
    await expect(secondCall).resolves.toBeUndefined()
    expect(process.noAsar).toBe(false)
  })
})
