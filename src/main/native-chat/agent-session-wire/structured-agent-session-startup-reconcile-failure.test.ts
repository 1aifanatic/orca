// The startup reconcile is bookkeeping: a lock that gives up or a store this build may not write
// is reported, and startup carries on. Nothing is owed after it, because every chat reconciles its
// own lease again when it is sent to or read.

import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as FileTransactionLock from '../../file-transaction-lock'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  AGENT_SESSION_STORE_SCHEMA_VERSION,
  agentSessionStorePath
} from '../../runtime/agent-session-record-store-file'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  adapter,
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'

const lock = vi.hoisted(() => ({ failing: false }))

vi.mock('../../file-transaction-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof FileTransactionLock>()
  return {
    ...actual,
    withFileTransactionLock: (...args: Parameters<typeof actual.withFileTransactionLock>) =>
      lock.failing
        ? // What proper-lockfile throws once its retries give up.
          Promise.reject(
            Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' })
          )
        : actual.withFileTransactionLock(...args)
  }
})

const relaunchedRoots: string[] = []

afterEach(async () => {
  lock.failing = false
  await Promise.all(
    relaunchedRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

/** A host with one chat, relaunched over a copy of its files; `rewrite` edits the copied store. */
async function relaunch(rewrite?: (json: Record<string, unknown>) => void) {
  const dying = hostTestState()
  await attach()
  // An empty renewal queues behind every record write, so they are on disk.
  await dying.store.renewLeases([])
  const relaunched = `${dying.root}-relaunched`
  relaunchedRoots.push(relaunched)
  // A dead process holds no lock.
  await cp(dying.root, relaunched, {
    recursive: true,
    filter: (source) => !source.includes('.lock')
  })
  const storeDirectory = join(relaunched, 'store')
  if (rewrite) {
    const path = agentSessionStorePath(storeDirectory)
    const json = JSON.parse(await readFile(path, 'utf-8'))
    rewrite(json)
    await writeFile(path, JSON.stringify(json))
  }
  const store = await AgentSessionRecordStore.open({ directory: storeDirectory, hostId: 'local' })
  const onStartupReconcileFailure = vi.fn()
  const host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalDatabase: openTestJournalHostDatabase(relaunched),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-next',
    probeOwner: async () => ({ outcome: 'pid-absent' }),
    now: () => NOW,
    onStartupReconcileFailure
  })
  replaceHostTestState({ store, host })
  return { host, store, storeDirectory, onStartupReconcileFailure }
}

it('reports a startup reconcile whose store write fails, and does not reject', async () => {
  const { host, store, onStartupReconcileFailure } = await relaunch()

  lock.failing = true
  await expect(host.reconcileRestartLeases()).resolves.toBeUndefined()

  expect(onStartupReconcileFailure).toHaveBeenCalledOnce()
  expect(onStartupReconcileFailure).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'ELOCKED' })
  )
  // Nothing was adjudicated, so the lease still grants no writer.
  expect(store.getRecord(SESSION)?.lease.unreconciled).toBe(true)
})

it('reconciles the chat on its next send once the store can be written again', async () => {
  const { host, store, onStartupReconcileFailure } = await relaunch()
  lock.failing = true
  await host.reconcileRestartLeases()
  expect(onStartupReconcileFailure).toHaveBeenCalledOnce()
  lock.failing = false

  const body = hostTestMessage('sent after a startup reconcile failed')
  await expect(
    host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).resolves.toMatchObject({ ok: true })

  // The send is queued; delivering it starts the agent, and that start reconciles the lease.
  await vi.waitFor(() => expect(hostTestState().dispatch).toHaveBeenCalledOnce(), {
    timeout: 10_000
  })
  expect(store.getRecord(SESSION)?.lease.unreconciled).toBe(false)
  expect(onStartupReconcileFailure).toHaveBeenCalledOnce()
  // Before the relaunched directory is removed, so the child's wind-down can write its lease.
  await host.flushAllStreamedEvents()
})

it('reports a store a newer Orca wrote without writing it, and does not reject', async () => {
  const { host, store, storeDirectory, onStartupReconcileFailure } = await relaunch((json) => {
    json.schemaVersion = AGENT_SESSION_STORE_SCHEMA_VERSION + 1
  })
  expect(store.readOnly).toBe(true)
  const path = agentSessionStorePath(storeDirectory)
  const bytes = await readFile(path)
  const files = await readdir(storeDirectory)

  await expect(host.reconcileRestartLeases()).resolves.toBeUndefined()

  expect(onStartupReconcileFailure).toHaveBeenCalledOnce()
  expect(onStartupReconcileFailure).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'agent_session_legacy_required' })
  )
  expect(store.listRecords().map((record) => record.sessionId)).toEqual([SESSION])
  expect(await readFile(path)).toEqual(bytes)
  expect(await readdir(storeDirectory)).toEqual(files)
})
