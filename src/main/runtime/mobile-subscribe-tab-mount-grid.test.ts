/**
 * A phone subscribing to a tab not mounted since relaunch must get the PTY's grid, not the pane's.
 *
 * With no renderer serializer the subscribe asks the desktop to mount the tab and waits for it.
 * The freshly mounted pane is hidden, so it answers its serializer at desktop size.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  EXPECTED_PHONE_ROWS,
  PHONE,
  PTY_ID,
  firstSnapshot,
  paintedRows,
  setupPhoneSubscribe,
  subscribePhone
} from './mobile-phone-subscribe-test-fixture'

describe('phone subscribe to a tab mounted on demand at desktop size', () => {
  it('serves the mount-wait snapshot from the model on the phone grid', async () => {
    const { runtime, handle, requestMount } = setupPhoneSubscribe({
      paneMounted: false,
      mount: 'ready'
    })

    const snapshot = await firstSnapshot(runtime, handle)

    expect(requestMount).toHaveBeenCalledTimes(1)
    expect({ cols: snapshot.cols, rows: snapshot.rows }).toEqual(PHONE)
    expect((await paintedRows(snapshot)).slice(0, 4)).toEqual(EXPECTED_PHONE_ROWS)
    const resubscribed = await firstSnapshot(runtime, handle)
    expect({ cols: resubscribed.cols, rows: resubscribed.rows }).toEqual(PHONE)
    expect((await paintedRows(resubscribed)).slice(0, 4)).toEqual(EXPECTED_PHONE_ROWS)
  })

  it('publishes a late mount-ready recovery on the phone grid', async () => {
    const { runtime, handle, finishMount } = setupPhoneSubscribe({
      paneMounted: false,
      mount: 'late'
    })
    const subscription = subscribePhone(runtime, handle)
    // The bounded initial response gives up on the mount before it settles.
    await vi.waitFor(() => expect(subscription.snapshots().length).toBe(1), { timeout: 5_000 })

    finishMount()
    await vi.waitFor(() => expect(subscription.snapshots().length).toBe(2))
    const recovery = subscription.snapshots()[1]
    await subscription.close()

    expect(recovery).toMatchObject({ kind: 'resized', reason: 'renderer-mount-ready', ...PHONE })
    expect((await paintedRows(recovery)).slice(0, 4)).toEqual(EXPECTED_PHONE_ROWS)
    expect(runtime.hasHeadlessTerminalState(PTY_ID)).toBe(true)
  }, 10_000)
})
