import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { AgentJournalItemIdentity } from '../../../src/shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import type { JournalRow } from '../../../src/main/native-chat/agent-session-journal/journal-row-schema'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// A release that predates `providerItemRef` on journal rows and render items.
const BASELINE_REF = 'v1.4.218'

const SESSION = 'session-provider-item-ref'

function message(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function releaseExport<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (value === undefined) {
    throw new Error(`the pinned release exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an export the pinned release has; each caller names the shape it uses, and a changed one fails the test.
  return value as T
}

type OldRenderItem = { itemId: string; [field: string]: unknown }

// Loads a real old build, including cold extraction and transforms.
test('an older host and client render a row carrying a provider item reference as if it had none', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-provider-item-ref-downgrade-'))
  const journals = createTrackedJournalOpener()
  try {
    // This build: the same message twice, the first carrying the reference.
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'ws-1',
        hostId: 'host-1',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      stateDirectory: directory,
      now: () => 1_000
    })
    const body = {
      kind: 'message' as const,
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: 'Hello' }]
    }
    const scope = { kind: 'thread' as const }
    await journal.appendItem(message(0), body, {
      fence: 1,
      turnScope: scope,
      providerItemRef: 'item:p:thread-1/item-1'
    })
    await journal.appendItem(message(1), body, { fence: 1, turnScope: scope })
    const since = journal.readSince({ epoch: journal.epoch, sequence: 0 })
    if (!since.ok) {
      throw new Error(`expected rows, got reset ${since.reset}`)
    }
    const rows: JournalRow[] = since.rows
    const current = journal.snapshot().items
    expect(current[0]?.providerItemRef).toBe('item:p:thread-1/item-1')

    const checkout = await materializeReleaseCheckout(BASELINE_REF)
    const [reducer, schemas, projection] = await Promise.all(
      [
        'src/main/native-chat/agent-session-journal/journal-reducer.ts',
        'src/shared/agent-session-journal-schemas.ts',
        'src/shared/structured-agent-session-projection.ts'
      ].map((path) => importReleaseCheckoutModule(checkout, path))
    )
    const createState = releaseExport<(sessionId: string, epoch: string) => unknown>(
      reducer,
      'createJournalReducerState'
    )
    const applyRow = releaseExport<(state: unknown, row: JournalRow) => void>(
      reducer,
      'applyJournalRow'
    )
    const render = releaseExport<(state: unknown) => { items: OldRenderItem[] }>(
      reducer,
      'renderJournalState'
    )
    const renderItemSchema = releaseExport<{ parse: (value: unknown) => OldRenderItem }>(
      schemas,
      'AgentJournalRenderItemSchema'
    )
    const project = releaseExport<(item: unknown) => unknown>(
      projection,
      'projectStructuredItemToNativeChat'
    )

    // The older host, after a downgrade, folds the rows as it always did.
    const state = createState(SESSION, journal.epoch)
    for (const row of rows) {
      applyRow(state, row)
    }
    const folded = render(state).items
    expect(folded.map((item) => item.itemId)).toEqual([
      'codex:thread-1:turn-1:0',
      'codex:thread-1:turn-1:1'
    ])
    const [first, second] = folded
    if (!first || !second) {
      throw new Error('the older host folded both rows')
    }
    expect(first).not.toHaveProperty('providerItemRef')
    const same = ({ itemId: _id, sequence: _seq, ...rest }: OldRenderItem) => rest
    expect(same(first)).toEqual(same(second))

    // The older client reads this host's render item without the field, and renders it the same.
    const [withRef, withoutRef] = current.map((item) => renderItemSchema.parse(item))
    if (!withRef || !withoutRef) {
      throw new Error('the older client read both items')
    }
    expect(withRef).not.toHaveProperty('providerItemRef')
    expect(project(withRef)).toEqual(
      project({ ...withoutRef, itemId: withRef.itemId, sequence: withRef.sequence })
    )
  } finally {
    await journals.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
})
