import './rpc/unused-default-rpc-methods.test-fixture'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkBoundMailbox,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

function workerMailbox() {
  const db = createDatabase('orca-unacked-worker-notice-')
  const harness = createRuntime(db)
  const run = db.createRun({
    objective: 'Continue hearing coordinator guidance',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444'
  })
  const task = db.createTask({ spec: 'Read guidance', runId: run.id })
  const dispatch = createRootDispatch(
    db,
    task.id,
    TERMINAL_HANDLE,
    PANE_KEY,
    undefined,
    `${PTY_ID}:mailbox-incarnation`
  )
  const mailbox = `dispatch:${dispatch.id}`
  const receive = (subject: string) => {
    const message = db.insertMessage({
      from: 'term_coordinator',
      to: mailbox,
      subject,
      runId: run.id
    })
    harness.runtime.notifyMessageArrived(mailbox, 'status')
    return message
  }
  return { db, ...harness, mailbox, receive }
}

describe('terminal worker notices after a check without acknowledgement', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['before new mail', 'after new mail'])(
    'notifies later guidance when the consumer goes idle %s',
    async (idleTiming) => {
      vi.useFakeTimers()
      const { db, runtime, write, mailbox, receive } = workerMailbox()
      try {
        await driveToLiveIdle(runtime)
        const first = receive('First guidance')
        await vi.advanceTimersByTimeAsync(500)
        expect(pointerCount(write)).toBe(1)
        const checked = await checkBoundMailbox(runtime)
        expect(checked.messages).toEqual([expect.objectContaining({ id: first.id })])
        expect(db.hasOutstandingMailboxDelivery(mailbox)).toBe(true)

        await runtime.acceptPtyDataBounded(PTY_ID, '\x1b]0;Codex working\x07', 3).completion
        if (idleTiming === 'before new mail') {
          await runtime.acceptPtyDataBounded(PTY_ID, '\x1b]0;Codex done\x07', 4).completion
        }
        const later = receive('Later guidance')
        await vi.advanceTimersByTimeAsync(500)
        if (idleTiming === 'after new mail') {
          expect(pointerCount(write)).toBe(1)
          await runtime.acceptPtyDataBounded(PTY_ID, '\x1b]0;Codex done\x07', 4).completion
          await vi.advanceTimersByTimeAsync(500)
        }
        expect(pointerCount(write)).toBe(2)
        expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(2)
        expect(db.getMessageById(later.id)).toMatchObject({
          read: 0,
          delivered_at: expect.any(String)
        })

        runtime.notifyMessageArrived(mailbox, 'status')
        runtime.deliverPendingMessagesForHandle(mailbox)
        await vi.advanceTimersByTimeAsync(500)
        expect(pointerCount(write)).toBe(2)
        const replayed = await checkBoundMailbox(runtime)
        expect(replayed.deliveryId).toBe(checked.deliveryId)
        expect(replayed.messages).toEqual([expect.objectContaining({ id: first.id })])
        const next = await checkBoundMailbox(runtime, { ack: checked.deliveryId ?? undefined })
        expect(next.messages).toEqual([expect.objectContaining({ id: later.id })])
      } finally {
        db.close()
      }
    }
  )
})
