import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeNotifier } from '../../runtime-notifier-contract'
import { registerRuntimeWindowLifecycle } from '../../../window/runtime-window-lifecycle'
import type { AgentLaunchRuntimeStub } from './agent-launch.test-fixture'

export function createLaunchFollowUpWindow(
  runtime: AgentLaunchRuntimeStub,
  contextRuntime: OrcaRuntimeService
) {
  let now = Date.now()
  const timers = new Set<{ at: number; run: () => void }>()
  const listeners = new Set<(operationId: string) => void>()
  const attached: { notifier: RuntimeNotifier | null } = { notifier: null }
  const settle = (operationId: string) => listeners.forEach((listener) => listener(operationId))
  Object.assign(runtime, {
    attachWindow: vi.fn(),
    markGraphReloadFailed: vi.fn(),
    markRendererReloading: vi.fn(() => ({})),
    markRendererReloadCancelled: vi.fn(() => true),
    setNotifier: (notifier: RuntimeNotifier | null) => {
      attached.notifier = notifier
    }
  })
  const send = vi.fn((channel: string, event: unknown) => {
    if (
      channel === 'ui:agentLaunchPromptSettled' &&
      event &&
      typeof event === 'object' &&
      'operationId' in event &&
      typeof event.operationId === 'string'
    ) {
      settle(event.operationId)
    }
  })
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    getURL: () => 'https://example.test/',
    send
  })
  const mainWindow = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => false,
    webContents
  })
  registerRuntimeWindowLifecycle(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration only uses the event and notification members implemented above.
    mainWindow as unknown as BrowserWindow,
    contextRuntime
  )
  runtime.reportAgentLaunchPromptSettled.mockImplementation((operationId) => {
    attached.notifier?.agentLaunchPromptSettled?.({ operationId })
  })
  return {
    webContents,
    send,
    clock: {
      now: () => now,
      schedule: (ms: number, run: () => void) => {
        const timer = { at: now + ms, run }
        timers.add(timer)
        return () => {
          timers.delete(timer)
        }
      },
      onSettled: (listener: (operationId: string) => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    },
    advance(ms: number) {
      now += ms
      vi.setSystemTime(now)
      for (const timer of timers) {
        if (timer.at <= now) {
          timers.delete(timer)
          timer.run()
        }
      }
    },
    get listenerCount() {
      return listeners.size
    }
  }
}
