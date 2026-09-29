import { describe, expect, it } from 'vitest'
import {
  captureNativeChatDeliveryOrigin,
  nativeChatDeliveryCheckDelay,
  observeNativeChatDeliveryOrigin,
  type NativeChatDeliveryStatus
} from './native-chat-pending-delivery'
const working: NativeChatDeliveryStatus = {
  state: 'working',
  stateStartedAt: 1,
  providerSession: { key: 'session_id', id: 'session' }
}

describe('terminal Chat confirmation evidence', () => {
  it('never times out a known working, waiting, or unchanged idle status', () => {
    for (const state of ['working', 'waiting', 'done'] as const) {
      const status = { ...working, state }
      const origin = captureNativeChatDeliveryOrigin(status, 9_000_000)
      expect(nativeChatDeliveryCheckDelay(origin, status, 99_000_000)).toBeNull()
    }
  })
  it('uses a later host idle boundary regardless of client clock skew', () => {
    const origin = captureNativeChatDeliveryOrigin(working, 9_000_000)
    expect(
      nativeChatDeliveryCheckDelay(
        origin,
        { ...working, state: 'done', stateStartedAt: 2 },
        9_000_001
      )
    ).toBe(0)
  })
  it('does not spend a replaced session, startup boundary, hydrated status, or disconnect as completion', () => {
    const origin = captureNativeChatDeliveryOrigin(working, 0)
    const idle = { ...working, state: 'done' as const, stateStartedAt: 2 }
    for (const status of [
      undefined,
      { ...idle, sessionBoundary: true },
      { ...idle, restoredUnconfirmed: true },
      { ...idle, providerSession: { key: 'session_id' as const, id: 'other' } }
    ]) {
      expect(nativeChatDeliveryCheckDelay(origin, status, 99_000_000)).toBeNull()
    }
  })
  it('bounds only sends without status facts, without resetting the deadline on remount', () => {
    const origin = captureNativeChatDeliveryOrigin(undefined, 1_000)
    expect(nativeChatDeliveryCheckDelay(origin, undefined, 5_000)).toBe(16_000)
    expect(nativeChatDeliveryCheckDelay(origin, undefined, 22_000)).toBe(0)
    expect(nativeChatDeliveryCheckDelay(origin, working, 22_000)).toBeNull()
  })
})

it('adopts a working fact first observed after sending, then uses its later idle fact', () => {
  const unknown = captureNativeChatDeliveryOrigin(undefined, 1_000)
  const known = observeNativeChatDeliveryOrigin(unknown, working)
  expect(known.sentAt).toBe(1_000)
  expect(nativeChatDeliveryCheckDelay(known, working, 120_000)).toBeNull()
  expect(
    nativeChatDeliveryCheckDelay(known, { ...working, state: 'done', stateStartedAt: 2 }, 120_001)
  ).toBe(0)
})
