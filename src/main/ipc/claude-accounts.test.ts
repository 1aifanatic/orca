import { describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  }
}))

import type { ClaudeAccountService } from '../claude-accounts/service'
import { registerClaudeAccountHandlers } from './claude-accounts'

describe('Claude account IPC', () => {
  it('says when terminals from an earlier Orca build are still running', async () => {
    const state = { accounts: [], activeAccountId: null }
    let older = true
    const service = {
      listAccounts: () => state,
      selectAccount: async () => state
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers call only the members stubbed above.
    registerClaudeAccountHandlers(service as unknown as ClaudeAccountService, async () => older)
    expect(await handlers.get('claudeAccounts:list')!()).toEqual({
      ...state,
      olderTerminalsRunning: true
    })
    expect(await handlers.get('claudeAccounts:select')!({}, { accountId: null })).toEqual({
      ...state,
      olderTerminalsRunning: true
    })
    older = false
    expect(await handlers.get('claudeAccounts:list')!()).toEqual(state)
  })
})
