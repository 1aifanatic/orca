// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const notice = vi.hoisted(() => ({ warning: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: notice }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { useProfileStateSaveDelayNotice } from './use-profile-state-save-delay-notice'

let snapshot: ReturnType<typeof Promise.withResolvers<boolean>>
const listeners = new Set<(delayed: boolean) => void>()
const subscribe = vi.fn((listener: (delayed: boolean) => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
})
const read = vi.fn(() => snapshot.promise)

beforeEach(() => {
  vi.clearAllMocks()
  snapshot = Promise.withResolvers<boolean>()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: {
        isProfileStateSaveDelayed: read,
        onProfileStateSaveDelayChanged: subscribe
      }
    }
  })
})
afterEach(() => {
  cleanup()
  listeners.clear()
})

function publish(delayed: boolean): void {
  act(() => listeners.forEach((listener) => listener(delayed)))
}

async function resolveSnapshot(delayed: boolean): Promise<void> {
  await act(async () => {
    snapshot.resolve(delayed)
    await snapshot.promise
  })
}

it('restores a persistent warning from main and clears it on completion', async () => {
  renderHook(useProfileStateSaveDelayNotice)
  expect(subscribe.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0])
  await resolveSnapshot(true)
  expect(notice.warning).toHaveBeenCalledExactlyOnceWith('Saving is taking longer than usual', {
    id: 'profile-state-save-delay',
    description: 'Recent changes haven’t been confirmed saved yet. Orca is still trying.',
    duration: Infinity,
    dismissible: false,
    closeButton: false
  })
  publish(false)
  expect(notice.dismiss).toHaveBeenLastCalledWith('profile-state-save-delay')
})

it('does not let an old healthy snapshot erase a newly delayed save', async () => {
  renderHook(useProfileStateSaveDelayNotice)
  publish(true)
  await resolveSnapshot(false)
  expect(notice.warning).toHaveBeenCalledOnce()
  expect(notice.dismiss).not.toHaveBeenCalled()
})

it('does not let an old delayed snapshot restore a recovered warning', async () => {
  renderHook(useProfileStateSaveDelayNotice)
  publish(false)
  await resolveSnapshot(true)
  expect(notice.warning).not.toHaveBeenCalled()
  expect(notice.dismiss).toHaveBeenCalledExactlyOnceWith('profile-state-save-delay')
})

it('removes its listener and ignores snapshots or queued events after unmount', async () => {
  const view = renderHook(useProfileStateSaveDelayNotice)
  const queuedListener = subscribe.mock.calls[0][0]
  view.unmount()
  expect(listeners.size).toBe(0)
  act(() => queuedListener(true))
  await resolveSnapshot(true)
  expect(notice.warning).not.toHaveBeenCalled()
  expect(notice.dismiss).toHaveBeenCalledExactlyOnceWith('profile-state-save-delay')
})

it('rehydrates a still-delayed save after the app shell remounts', async () => {
  const first = renderHook(useProfileStateSaveDelayNotice)
  await resolveSnapshot(true)
  first.unmount()
  renderHook(useProfileStateSaveDelayNotice)
  await act(async () => {
    await snapshot.promise
  })
  expect(notice.warning).toHaveBeenCalledTimes(2)
  expect(
    notice.warning.mock.calls.every(([, options]) => options.id === 'profile-state-save-delay')
  ).toBe(true)
})
