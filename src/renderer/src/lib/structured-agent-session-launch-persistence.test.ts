// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  hasStructuredAgentLaunchCancellationTombstonePersisted,
  readStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests,
  readStructuredAgentLaunchCancellationTombstoneSessionIds,
  retireAbsentStructuredAgentLaunchCancellationTombstonesPersisted,
  retireStructuredAgentLaunchCancellationTombstonePersisted,
  writeStructuredAgentLaunchRecord,
  markStructuredAgentLaunchCancelledPersisted
} from './structured-agent-session-launch-persistence'

const SERVER = 'runtime:server-1'
const TOMBSTONES_KEY = 'orca:structuredAgentLaunchCancelledSessions:v1'

function reload(): void {
  resetStructuredAgentLaunchPersistenceForTests()
}

describe('structured agent launch persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
  })

  it('normalizes pending launches after a renderer reload', () => {
    localStorage.setItem(
      'orca:structuredAgentLaunches:v1',
      JSON.stringify([
        {
          sessionId: 'codex_session',
          agent: 'codex',
          lifecycle: 'pending',
          clientOperationId: 'operation-1',
          payloadFingerprint: 'fingerprint-1',
          expectedRuntimeFence: null
        }
      ])
    )

    expect(readStructuredAgentLaunchRecord('codex_session')).toMatchObject({
      lifecycle: 'visibility-unknown',
      clientOperationId: 'operation-1',
      // Written before a paired host could hold a chat, so it was launched on this machine.
      executionHostId: 'local'
    })
  })

  it('keeps the host a launch was created on across a reload', () => {
    writeStructuredAgentLaunchRecord({
      sessionId: 'claude_remote',
      executionHostId: SERVER,
      agent: 'claude',
      lifecycle: 'pending',
      clientOperationId: 'operation-3',
      payloadFingerprint: 'fingerprint-3',
      expectedRuntimeFence: null
    })
    reload()

    expect(readStructuredAgentLaunchRecord('claude_remote')?.executionHostId).toBe(SERVER)
  })

  it('stores only content-free identity and preserves operation identity', () => {
    writeStructuredAgentLaunchRecord({
      sessionId: 'claude_session',
      executionHostId: 'local',
      agent: 'claude',
      lifecycle: 'visibility-unknown',
      clientOperationId: 'operation-2',
      payloadFingerprint: 'fingerprint-2',
      expectedRuntimeFence: null,
      resumeFrom: { providerSessionId: 'provider-thread' }
    })

    const raw = localStorage.getItem('orca:structuredAgentLaunches:v1') ?? ''
    expect(raw).toContain('claude_session')
    expect(raw).toContain('operation-2')
    expect(raw).not.toContain('prompt')
    expect(raw).not.toContain('branch')
    expect(raw).not.toContain('path')
    expect(readStructuredAgentLaunchRecord('claude_session')?.clientOperationId).toBe('operation-2')
  })

  it('persists cancellation tombstones by session id and retires them', () => {
    markStructuredAgentLaunchCancelledPersisted('codex_session', 'local')
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('codex_session')).toBe(true)
    // A local chat's tombstone keeps the shape older builds read.
    expect(localStorage.getItem(TOMBSTONES_KEY)).toBe('["codex_session"]')
    expect(retireStructuredAgentLaunchCancellationTombstonePersisted('codex_session')).toBe(true)
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('codex_session')).toBe(false)
  })

  it("keeps a paired host's tombstone under that host across a reload", () => {
    markStructuredAgentLaunchCancelledPersisted('remote_session', SERVER)
    markStructuredAgentLaunchCancelledPersisted('local_session', 'local')
    reload()

    expect(readStructuredAgentLaunchCancellationTombstoneSessionIds(SERVER)).toEqual([
      'remote_session'
    ])
    expect(readStructuredAgentLaunchCancellationTombstoneSessionIds('local')).toEqual([
      'local_session'
    ])
  })

  it('retires only the tombstones of the host whose inventory omitted them', () => {
    markStructuredAgentLaunchCancelledPersisted('remote_session', SERVER)
    markStructuredAgentLaunchCancelledPersisted('local_session', 'local')

    expect(
      retireAbsentStructuredAgentLaunchCancellationTombstonesPersisted(new Set(), 'local')
    ).toBe(true)
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('local_session')).toBe(false)
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('remote_session')).toBe(true)
  })

  it("expires a paired host's tombstone that host never answered for", () => {
    const expired = Date.now() - 31 * 24 * 60 * 60 * 1000
    localStorage.setItem(
      TOMBSTONES_KEY,
      JSON.stringify([
        { sessionId: 'stale_remote', executionHostId: SERVER, cancelledAt: expired },
        { sessionId: 'fresh_remote', executionHostId: SERVER, cancelledAt: Date.now() }
      ])
    )

    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('stale_remote')).toBe(false)
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('fresh_remote')).toBe(true)
  })
})
