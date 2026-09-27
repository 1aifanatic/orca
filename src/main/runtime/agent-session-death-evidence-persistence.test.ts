import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionDeathEvidence } from '../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'

const SESSION = 'session-alpha-1'
/** The fixture lease's last renewal. */
const LAST_RENEWED_AT = 30_000

let directory: string

async function seed(deathEvidence: AgentSessionDeathEvidence | null): Promise<void> {
  const lease =
    deathEvidence === null
      ? agentSessionLeaseFixture()
      : agentSessionLeaseFixture({
          ownerProcess: null,
          reservedSpawnToken: null,
          claimStatus: 'released',
          deathEvidence
        })
  await writeFile(
    agentSessionStorePath(directory),
    JSON.stringify({
      schemaVersion: 2,
      hostId: 'local',
      records: { [SESSION]: agentSessionRecordFixture(lease) },
      operations: {},
      retiredClaimKeys: [],
      unusableRecords: {}
    })
  )
}

function open(): Promise<AgentSessionRecordStore> {
  return AgentSessionRecordStore.open({ directory, hostId: 'local' })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-death-evidence-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('death evidence on disk', () => {
  it('records the last renewal before the crash and reads it back after another restart', async () => {
    await seed(null)
    const crashed = await open()
    await crashed.reconcileOnRestart({
      probe: async () => ({ outcome: 'pid-absent' }),
      now: 90_000
    })
    const evidence = {
      kind: 'pid-absent',
      detail: 'recorded pid absent on host',
      observedAt: 90_000,
      lastProvenAliveAt: LAST_RENEWED_AT
    }
    expect(crashed.getRecord(SESSION)?.lease.deathEvidence).toEqual(evidence)
    expect((await open()).getRecord(SESSION)?.lease.deathEvidence).toEqual(evidence)
  })

  it('loads evidence an older build wrote without a proven-alive time', async () => {
    const olderBuild = { kind: 'pid-absent' as const, detail: 'gone', observedAt: 90_000 }
    await seed(olderBuild)
    const store = await open()
    expect(store.isSessionUnreadable(SESSION)).toBe(false)
    expect(store.getRecord(SESSION)?.lease.deathEvidence).toEqual(olderBuild)
  })

  it('quarantines evidence that proves the owner alive after the probe found it gone', async () => {
    await seed({
      kind: 'pid-absent',
      detail: 'gone',
      observedAt: 90_000,
      lastProvenAliveAt: 90_001
    })
    expect((await open()).isSessionUnreadable(SESSION)).toBe(true)
  })
})
