/**
 * With no host model, a terminal buffer read falls back to the desktop pane. A hidden pane answers
 * at its own size, so the read must seed the model onto the PTY grid and answer from it. This read
 * backs the phone's resize restream and pending-output recovery.
 */
import { describe, expect, it } from 'vitest'
import {
  DESKTOP,
  EXPECTED_PHONE_ROWS,
  PHONE,
  PTY_ID,
  internals,
  paintedRows,
  setupPhoneSubscribe
} from './mobile-phone-subscribe-test-fixture'

async function readOnPhoneGrid(opts: { providerPreferred: boolean }) {
  const { runtime, sizes } = setupPhoneSubscribe({ paneMounted: true })
  sizes.set(PTY_ID, { ...PHONE })
  if (opts.providerPreferred) {
    internals(runtime).providerSnapshotPreferredPtys.add(PTY_ID)
  }
  const snapshot = await runtime.serializeTerminalBuffer(PTY_ID, { scrollbackRows: 100 })
  return { runtime, snapshot }
}

describe('terminal buffer read with no host model and a desktop-sized pane', () => {
  it('answers from a model seeded onto the PTY grid', async () => {
    const { runtime, snapshot } = await readOnPhoneGrid({ providerPreferred: false })

    expect(snapshot).toMatchObject({ source: 'headless', ...PHONE })
    expect(snapshot && (await paintedRows(snapshot)).slice(0, 4)).toEqual(EXPECTED_PHONE_ROWS)
    expect(runtime.hasHeadlessTerminalState(PTY_ID)).toBe(true)
  })

  it('answers from the model when a restored snapshot is preferred but the provider has none', async () => {
    const { snapshot } = await readOnPhoneGrid({ providerPreferred: true })

    expect(snapshot).toMatchObject({ source: 'headless', ...PHONE })
    expect(snapshot?.cols).not.toBe(DESKTOP.cols)
  })
})
