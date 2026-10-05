import { create } from 'zustand'
import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { AppState } from '../types'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from '@/web/web-preload-api-test-harness'
import { createJiraSlice } from './jira'

function createTestStore() {
  return create<AppState>()((...args) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Connection reads use only settings and the fully initialized Jira slice.
    return { settings: null, ...createJiraSlice(...args) } as AppState
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('@/web/web-runtime-client')
  vi.resetModules()
})

it('reads the paired web client Jira status from the runtime instead of the fallback proxy', async () => {
  const status = {
    connected: true,
    viewer: { displayName: 'Ada', email: 'ada@example.com', accountId: 'acc-1' }
  }
  const methods: string[] = []
  vi.doMock('@/web/web-runtime-client', () => ({
    WebRuntimeClient: class {
      call(method: string): Promise<RuntimeRpcResponse<unknown>> {
        methods.push(method)
        return Promise.resolve({
          id: 'status-1',
          ok: true,
          result: method === 'jira.status' ? status : null,
          _meta: { runtimeId: 'runtime-1' }
        })
      }

      close(): void {}
    }
  }))
  const globals = installBrowserGlobals('Linux')
  writeStoredRuntimeEnvironment(globals.storage)
  const { installWebPreloadApi } = await import('@/web/web-preload-api')
  installWebPreloadApi()
  const store = createTestStore()

  await expect(store.getState().checkJiraConnection()).resolves.toBeUndefined()

  expect(methods).toEqual(['jira.status'])
  expect(store.getState().jiraStatus).toEqual(status)
  expect(store.getState().jiraStatusChecked).toBe(true)
  expect(store.getState().jiraStatusContextKey).toBe('local#0')
})
