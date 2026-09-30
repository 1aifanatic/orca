import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPtyProvider, PtyProcessInfo } from '../providers/types'
import {
  answeredProcesses,
  requireCompleteProcessListing
} from '../providers/pty-process-source-listing'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  DaemonListingDeadlineError,
  listDaemonProcessesBySource,
  listPerGeneration,
  type DaemonInventoryRead
} from './daemon-generation-listing'

function process(id: string): PtyProcessInfo {
  return { id, cwd: '', title: 'shell' }
}

function adapter(
  protocolVersion: number,
  read: () => Promise<DaemonInventoryRead<PtyProcessInfo>>,
  activeIds: string[] = []
): DaemonPtyAdapter {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listing reads only protocolVersion, readProcesses and getActiveSessionIds.
  return {
    protocolVersion,
    readProcesses: vi.fn(read),
    getActiveSessionIds: () => activeIds
  } as unknown as DaemonPtyAdapter
}

const never = <T>(): Promise<T> => new Promise<T>(() => {})

describe('listPerGeneration', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the answered sources at the deadline while one source stays silent', async () => {
    vi.useFakeTimers()
    const listing = listPerGeneration<string, string>(
      ['current', 'frozen'],
      (source) =>
        source === 'current' ? Promise.resolve({ contact: 'live', items: ['a'] }) : never(),
      Date.now() + 3_000
    )
    await vi.advanceTimersByTimeAsync(3_000)

    const [current, frozen] = await listing
    expect(current).toEqual({ source: 'current', contact: 'live', items: ['a'] })
    expect(frozen).toMatchObject({ source: 'frozen', contact: 'unverifiable' })
    expect(frozen.contact === 'unverifiable' && frozen.error).toBeInstanceOf(
      DaemonListingDeadlineError
    )
  })

  it('keeps an exited source distinct from one that answered with nothing', async () => {
    const listing = await listPerGeneration<string, string>(['gone', 'empty'], async (source) =>
      source === 'gone' ? { contact: 'exited' } : { contact: 'live', items: [] }
    )

    expect(listing.map((entry) => entry.contact)).toEqual(['exited', 'live'])
  })

  it('keeps a read that throws before returning a promise to its own source', async () => {
    const listing = await listPerGeneration<string, string>(['broken', 'fine'], (source) => {
      if (source === 'broken') {
        throw new Error('not a daemon')
      }
      return Promise.resolve({ contact: 'live', items: ['a'] })
    })

    expect(listing.map((entry) => entry.contact)).toEqual(['unverifiable', 'live'])
  })

  it('reports a source whose read rejected as unverifiable, carrying its error', async () => {
    const failure = new Error('socket dead')
    const [entry] = await listPerGeneration<string, string>(['old'], async () => {
      throw failure
    })

    expect(entry).toEqual({ source: 'old', contact: 'unverifiable', error: failure })
  })
})

describe('listDaemonProcessesBySource', () => {
  it('names what a silent version was last known to hold, from routes and attached ids', async () => {
    const current = adapter(36, async () => ({ contact: 'live', items: [process('wt@@new')] }))
    const frozen = adapter(
      35,
      async () => {
        throw new Error('Request listSessions timed out')
      },
      ['wt@@attached']
    )
    const routes = new Map<string, IPtyProvider>([
      ['wt@@routed', frozen],
      ['wt@@new', current]
    ])

    const listings = await listDaemonProcessesBySource(
      { adapters: [current, frozen], current },
      routes
    )

    expect(listings[0]).toMatchObject({ protocolVersion: 36, isCurrent: true, contact: 'live' })
    expect(listings[1]).toMatchObject({ protocolVersion: 35, isCurrent: false })
    expect(listings[1].contact === 'unverifiable' && listings[1].lastKnownIds.sort()).toEqual([
      'wt@@attached',
      'wt@@routed'
    ])
    expect(answeredProcesses(listings).map((entry) => entry.id)).toEqual(['wt@@new'])
    expect(() => requireCompleteProcessListing(listings)).toThrow('Request listSessions timed out')
  })

  it('counts an exited version as complete and empty', async () => {
    const current = adapter(36, async () => ({ contact: 'live', items: [process('wt@@new')] }))
    const exited = adapter(35, async () => ({ contact: 'exited' }))

    const listings = await listDaemonProcessesBySource(
      { adapters: [current, exited], current },
      new Map()
    )

    expect(requireCompleteProcessListing(listings).map((entry) => entry.id)).toEqual(['wt@@new'])
  })
})
