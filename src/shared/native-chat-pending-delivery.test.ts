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
const idle: NativeChatDeliveryStatus = { ...working, state: 'done', stateStartedAt: 1 }

describe('terminal Chat confirmation evidence', () => {
  it('never checks a send made into a busy turn, even after that turn ends', () => {
    for (const state of ['working', 'waiting', 'blocked'] as const) {
      const origin = captureNativeChatDeliveryOrigin({ ...working, state }, 9_000_000)
      expect(nativeChatDeliveryCheckDelay(origin, { ...working, state }, 99_000_000)).toBeNull()
      expect(
        nativeChatDeliveryCheckDelay(origin, { ...idle, stateStartedAt: 2 }, 99_000_000)
      ).toBeNull()
    }
  })
  it('checks a send into an idle agent once a later turn ends, regardless of client clock skew', () => {
    const origin = captureNativeChatDeliveryOrigin(idle, 9_000_000)
    expect(
      nativeChatDeliveryCheckDelay(origin, { ...working, stateStartedAt: 2 }, 99_000_000)
    ).toBe(null)
    expect(nativeChatDeliveryCheckDelay(origin, { ...idle, stateStartedAt: 3 }, 9_000_001)).toBe(0)
  })
  it('bounds a send an idle agent never starts a turn for', () => {
    const origin = captureNativeChatDeliveryOrigin(idle, 1_000)
    expect(nativeChatDeliveryCheckDelay(origin, idle, 5_000)).toBe(16_000)
    expect(nativeChatDeliveryCheckDelay(origin, idle, 22_000)).toBe(0)
    expect(nativeChatDeliveryCheckDelay(origin, { ...idle, sessionBoundary: true }, 22_000)).toBe(0)
  })
  it('does not spend a replaced session, later boundary, hydrated status, or disconnect as completion', () => {
    const origin = captureNativeChatDeliveryOrigin(idle, 0)
    const later = { ...idle, stateStartedAt: 2 }
    for (const status of [
      undefined,
      { ...later, sessionBoundary: true },
      { ...later, restoredUnconfirmed: true },
      { ...later, providerSession: { key: 'session_id' as const, id: 'other' } }
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
  expect(known.stateAtSend).toBeNull()
  expect(nativeChatDeliveryCheckDelay(known, working, 120_000)).toBeNull()
  expect(
    nativeChatDeliveryCheckDelay(known, { ...working, state: 'done', stateStartedAt: 2 }, 120_001)
  ).toBe(0)
})
