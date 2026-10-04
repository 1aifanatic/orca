import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import { createTrackedJournalOpener } from './journal-host-database-test-support'

const journals = createTrackedJournalOpener()
const roots: string[] = []

afterEach(async () => {
  await journals.closeAll()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function open(root?: string) {
  const directory = root ?? (await mkdtemp(join(tmpdir(), 'orca-provider-item-ref-')))
  if (!root) {
    roots.push(directory)
  }
  const journal = await journals.open({
    identity: {
      sessionId: 'session-ref',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'root' }
    },
    stateDirectory: directory,
    now: () => 1_000
  })
  return { journal, directory }
}

const row: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'root',
  turnId: 't1',
  ordinal: 0
}
const text = (value: string) => ({
  kind: 'message' as const,
  role: 'assistant' as const,
  blocks: [{ type: 'text' as const, text: value }]
})
const scope = { kind: 'turn', turnItemId: 'turn:t1' } as const

describe('a row’s provider item reference', () => {
  it('is the creating write’s, kept by revisions and indexed for its producer', async () => {
    const { journal } = await open()
    await journal.appendItem(row, text('a'), { fence: 1, turnScope: scope, providerItemRef: 'm0' })
    await journal.appendItem(row, text('ab'), { fence: 1, turnScope: scope, providerItemRef: 'm9' })
    await journal.appendItem(row, text('abc'), { fence: 1, turnScope: scope })

    expect(journal.item('codex:root:t1:0')).toMatchObject({
      providerItemRef: 'm0',
      body: text('abc')
    })
    expect(journal.itemIdForProviderItemRef('m0')).toBe('codex:root:t1:0')
    expect(journal.itemIdForProviderItemRef('m9')).toBeNull()
  })

  it('survives a reopen, and leaves the index with its row', async () => {
    const { journal, directory } = await open()
    await journal.appendItem(row, text('a'), { fence: 1, turnScope: scope, providerItemRef: 'm0' })
    await journals.closeAll()

    const { journal: reopened } = await open(directory)
    expect(reopened.itemIdForProviderItemRef('m0')).toBe('codex:root:t1:0')
    await reopened.appendTombstone(row, { fence: 1 })
    expect(reopened.itemIdForProviderItemRef('m0')).toBeNull()
  })
})
