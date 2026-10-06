import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationDismissEvent
} from '../../../src/main/runtime/runtime-mobile-notification-controller'
import { dismissHostPushNotification } from './push-socket-dismissal'
import { deriveHostFingerprint } from './push-host-fingerprint'
const native = vi.hoisted(() => ({ catalog: vi.fn(), presented: vi.fn(), dismiss: vi.fn() }))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: native.catalog }))
vi.mock('expo-notifications', () => ({
  getPresentedNotificationsAsync: native.presented,
  dismissNotificationAsync: native.dismiss
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))

it('a restarted host socket withdrawal removes the original native alert and preserves newer identities', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-phone-retirement-'))
  try {
    const publicKeyB64 = Buffer.alloc(32, 1).toString('base64')
    native.catalog.mockResolvedValue([{ id: 'host-a', publicKeyB64 }])
    const original = new RuntimeMobileNotificationController()
    original.configureDismissalStore(directory)
    original.dispatch({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Allow?',
      body: '',
      notificationId: 'same',
      structuredOrigin: {
        scope: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'folder',
          workspaceKind: 'folder'
        },
        sessionId: 'session-a',
        journalCursor: { epoch: 'journal-a', sequence: 1 },
        cause: { kind: 'prompt', promptId: 'A' }
      }
    })
    const restarted = new RuntimeMobileNotificationController()
    restarted.configureDismissalStore(directory)
    const hostFingerprint = deriveHostFingerprint(publicKeyB64)
    const presented = (
      identifier: string,
      notificationEpoch: string,
      notificationSeq: number,
      fingerprint = hostFingerprint
    ) => ({
      request: {
        identifier,
        content: {
          data: {
            hostFingerprint: fingerprint,
            notificationId: 'same',
            notificationEpoch,
            notificationSeq
          }
        }
      }
    })
    native.presented.mockResolvedValue([
      presented('original', original.getEpoch(), 1),
      presented('newer', original.getEpoch(), 2),
      presented('restart', restarted.getEpoch(), 1),
      presented('other-host', original.getEpoch(), 1, 'other')
    ])
    let event: MobileNotificationDismissEvent | undefined
    restarted.onDispatched((value) => {
      if (value.type === 'dismiss') {
        event = value
      }
    })
    restarted.retireStructuredAttention({
      sessionId: 'session-a',
      observedCursor: { epoch: 'journal-a', sequence: 1 }
    })
    if (!event) {
      throw new Error('read did not withdraw the prompt')
    }
    await dismissHostPushNotification(event, 'host-a')
    expect(native.dismiss.mock.calls).toEqual([['original']])
    expect(event.notificationEpoch).toBe(restarted.getEpoch())
    expect(event.dismissedDelivery?.notificationEpoch).toBe(original.getEpoch())
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
