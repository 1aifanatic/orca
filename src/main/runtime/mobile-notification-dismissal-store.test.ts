import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileNotificationDismissalStore } from './mobile-notification-dismissal-store'
const paths: string[] = []
afterEach(() => {
  paths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
  vi.restoreAllMocks()
})
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'orca-dismissals-'))
  paths.push(path)
  return { path, store: new MobileNotificationDismissalStore(path) }
}
const shown = { notificationId: 'same', notificationEpoch: 'old', notificationSeq: 12 }
const alert = {
  type: 'notification' as const,
  source: 'terminal-bell' as const,
  title: 'QA',
  body: ''
}
it('reconciles an old delivered alert after desktop restart and preserves unrelated identities', () => {
  const h = fixture()
  h.store.record({ ...alert, ...shown })
  const restarted = new MobileNotificationDismissalStore(h.path)
  restarted.record({
    type: 'dismiss',
    notificationId: 'same',
    notificationEpoch: 'new',
    notificationSeq: 1
  })
  const loaded = new MobileNotificationDismissalStore(h.path)
  expect(
    loaded.reconcile([
      shown,
      { ...shown, notificationEpoch: 'other' },
      { ...shown, notificationId: 'other' },
      { ...shown, notificationSeq: 13 }
    ])
  ).toEqual([shown])
})
it('does not dismiss a newer replacement and does not treat missing or expired history as dismissal', () => {
  const h = fixture()
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now)
  h.store.record({ ...alert, ...shown })
  h.store.record({ type: 'dismiss', ...shown, notificationSeq: 13 })
  expect(h.store.reconcile([shown])).toEqual([shown])
  h.store.record({ ...alert, ...shown, notificationSeq: 14 })
  expect(h.store.reconcile([{ ...shown, notificationSeq: 14 }])).toEqual([])
  expect(h.store.reconcile([shown])).toEqual([shown])
  h.store.record({ type: 'dismiss', ...shown, notificationSeq: 15 })
  vi.mocked(Date.now).mockReturnValue(now + 7 * 86400_000)
  expect(h.store.reconcile([shown])).toEqual([])
  expect(new MobileNotificationDismissalStore(`${h.path}-unknown`).reconcile([shown])).toEqual([])
})
it('names the live deliveries a subject can still retire, across a restart', () => {
  const h = fixture()
  const keyed = (notificationId: string, notificationSeq: number) => ({
    ...alert,
    notificationId,
    notificationEpoch: 'e',
    notificationSeq
  })
  h.store.record(keyed('subject:prompt:a1', 1))
  h.store.record(keyed('subject:prompt:a10', 2))
  h.store.record(keyed('other:prompt:a1', 3))
  h.store.record({
    type: 'dismiss',
    notificationId: 'subject:prompt:a10',
    notificationEpoch: 'e',
    notificationSeq: 4
  })
  const restarted = new MobileNotificationDismissalStore(h.path)
  expect(restarted.liveDeliveryIds('subject:')).toEqual(['subject:prompt:a1'])
  expect(restarted.hasLiveDelivery('subject:prompt:a1')).toBe(true)
  expect(restarted.hasLiveDelivery('subject:prompt:a10')).toBe(false)
  expect(restarted.hasLiveDelivery('subject:prompt:a')).toBe(false)
})
