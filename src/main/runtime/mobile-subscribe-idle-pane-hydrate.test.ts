/**
 * A phone subscribing to an idle reattached PTY must get its first snapshot on the phone grid.
 *
 * After a relaunch the reattach skips seeding the host model because a pane is mounted; the PTY
 * then emits no byte (an agent waiting for input), and the pane, hidden in another workspace,
 * answers its serializer at desktop size.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  EXPECTED_PHONE_ROWS,
  PHONE,
  PTY_ID,
  firstSnapshot,
  internals,
  paintedRows,
  setupPhoneSubscribe as setup,
  subscribePhone
} from './mobile-phone-subscribe-test-fixture'

describe('phone subscribe to an idle PTY whose hidden pane sits at desktop size', () => {
  it('serves the first snapshot from a host model hydrated onto the phone grid', async () => {
    const { runtime, handle, sizes } = setup({ paneMounted: true })
    expect(runtime.hasHeadlessTerminalState(PTY_ID)).toBe(false)

    const snapshot = await firstSnapshot(runtime, handle)

    expect(sizes.get(PTY_ID)).toEqual(PHONE)
    expect({ cols: snapshot.cols, rows: snapshot.rows }).toEqual(PHONE)
    expect((await paintedRows(snapshot)).slice(0, 4)).toEqual(EXPECTED_PHONE_ROWS)
    expect(runtime.hasHeadlessTerminalState(PTY_ID)).toBe(true)
  })

  it('serves the phone grid when a reattach left the restored snapshot preferred', async () => {
    const { runtime, handle } = setup({ paneMounted: true, providerSnapshot: true })
    // A continued daemon generation marks the model unsafe until a full snapshot arrives.
    internals(runtime).providerSnapshotPreferredPtys.add(PTY_ID)

    const snapshot = await firstSnapshot(runtime, handle)

    expect({ cols: snapshot.cols, rows: snapshot.rows }).toEqual(PHONE)
    expect((await paintedRows(snapshot)).slice(0, 4)).toEqual(EXPECTED_PHONE_ROWS)
    const resubscribed = await firstSnapshot(runtime, handle)
    expect({ cols: resubscribed.cols, rows: resubscribed.rows }).toEqual(PHONE)
  })

  it('joins a hydrate the resize repaint already started', async () => {
    const { runtime, handle, serializeBuffer } = setup({ paneMounted: true, repaintOnResize: true })

    const snapshot = await firstSnapshot(runtime, handle)

    expect({ cols: snapshot.cols, rows: snapshot.rows }).toEqual(PHONE)
    expect((await paintedRows(snapshot)).slice(0, 4)).toEqual(EXPECTED_PHONE_ROWS)
    expect(serializeBuffer).toHaveBeenCalledTimes(1)
  })

  it('keeps serving the model on resubscribe without re-reading the pane', async () => {
    const { runtime, handle, serializeBuffer } = setup({ paneMounted: true })
    await firstSnapshot(runtime, handle)
    const panesReadForFirst = serializeBuffer.mock.calls.length

    const snapshot = await firstSnapshot(runtime, handle)

    expect({ cols: snapshot.cols, rows: snapshot.rows }).toEqual(PHONE)
    expect((await paintedRows(snapshot)).slice(0, 4)).toEqual(EXPECTED_PHONE_ROWS)
    expect(serializeBuffer.mock.calls.length).toBe(panesReadForFirst)
  })

  it('chains a live repaint after the hydrated seed', async () => {
    const { runtime, handle } = setup({ paneMounted: true })
    await firstSnapshot(runtime, handle)
    runtime.onPtyData(PTY_ID, '\r\n$ repainted', Date.now())

    const snapshot = await firstSnapshot(runtime, handle)

    expect((await paintedRows(snapshot)).slice(0, 5)).toEqual([
      ...EXPECTED_PHONE_ROWS,
      '$ repainted'
    ])
  })

  it('leaves a PTY with no pane serializer to the renderer mount path', async () => {
    const { runtime, handle, requestMount } = setup({ paneMounted: false })

    const subscription = subscribePhone(runtime, handle)
    await vi.waitFor(() => expect(subscription.snapshots().length).toBeGreaterThan(0), {
      timeout: 5_000
    })
    await subscription.close()

    expect(requestMount).toHaveBeenCalledTimes(1)
    expect(runtime.hasHeadlessTerminalState(PTY_ID)).toBe(false)
  })
})
