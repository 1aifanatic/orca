import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import { dispatchMobileStructuredCommand } from './mobile-structured-composer-command'
import { resetQueuedRestoreJournalForTests } from './mobile-structured-queued-restore-journal'

function setup() {
  const sendRequest = vi.fn(async (_method: string, _params: unknown, _options: unknown) => ({
    ok: true,
    result: { ok: true, value: { command: 'compact', state: 'completed' } }
  }))
  const input: Parameters<typeof dispatchMobileStructuredCommand>[0] = {
    text: '/compact',
    hasAttachments: false,
    client: { sendRequest } as unknown as RpcClient,
    sessionId: 'session',
    fence: 1,
    sessionKey: 'session:1',
    pending: { current: false },
    operationIds: new Map(),
    controller: {
      agent: 'codex',
      snapshot: [],
      invokeAction: vi.fn(async () => true),
      setOption: vi.fn(async () => true),
      conversationCommands: ['clear', 'compact']
    },
    canRun: () => true,
    onError: vi.fn(),
    timeoutMs: 15000
  }
  return { input, sendRequest }
}
describe('mobile structured conversation commands', () => {
  let stored: Map<string, string>
  beforeEach(() => {
    vi.clearAllMocks()
    resetQueuedRestoreJournalForTests()
    stored = new Map()
    asyncStorage.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null)
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value)
    })
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      stored.delete(key)
    })
  })
  it.each(['/clear', '/compact'])(
    'uses the command RPC for %s without an ordinary send',
    async (text) => {
      const { input, sendRequest } = setup()
      expect(await dispatchMobileStructuredCommand({ ...input, text })).toBe('accepted')
      expect(sendRequest).toHaveBeenCalledWith(
        'agentSession.conversationCommand',
        expect.objectContaining({ command: text.slice(1) }),
        expect.anything()
      )
      expect(input.operationIds.size).toBe(0)
    }
  )
  it('retains the exact operation ID after an unknown response', async () => {
    const { input, sendRequest } = setup()
    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, value: { command: 'compact', state: 'unknown' } }
    })
    expect(await dispatchMobileStructuredCommand(input)).toBe('unknown')
    expect(await dispatchMobileStructuredCommand(input)).toBe('accepted')
    expect(sendRequest.mock.calls[0]?.[1]).toEqual(sendRequest.mock.calls[1]?.[1])
  })
  it('retains operation identity when the host explicitly reports an unknown ledger outcome', async () => {
    const { input, sendRequest } = setup()
    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: false,
        refusal: { code: 'agent_session_operation_unknown', message: 'unconfirmed' }
      }
    } as never)
    expect(await dispatchMobileStructuredCommand(input)).toBe('unknown')
    expect(await dispatchMobileStructuredCommand(input)).toBe('accepted')
    expect(sendRequest.mock.calls[0]?.[1]).toEqual(sendRequest.mock.calls[1]?.[1])
  })
  it('retains operation identity when the host fails after starting the command', async () => {
    const { input, sendRequest } = setup()
    sendRequest.mockResolvedValueOnce({
      ok: false,
      error: { code: 'runtime_error', message: 'settlement failed' }
    } as never)
    expect(await dispatchMobileStructuredCommand(input)).toBe('unknown')
    expect(await dispatchMobileStructuredCommand(input)).toBe('accepted')
    expect(sendRequest.mock.calls[0]?.[1]).toEqual(sendRequest.mock.calls[1]?.[1])
  })
  it.each(['attachments', 'old host', 'arguments', 'pending work'])(
    'guards %s without provider dispatch',
    async (reason) => {
      const { input, sendRequest } = setup()
      if (reason === 'attachments') {
        input.hasAttachments = true
      }
      if (reason === 'old host') {
        input.controller.conversationCommands = undefined
      }
      if (reason === 'arguments') {
        input.text = '/compact instructions'
      }
      if (reason === 'pending work') {
        input.canRun = () => false
      }
      expect(await dispatchMobileStructuredCommand(input)).toBe('rejected')
      expect(sendRequest).not.toHaveBeenCalled()
      expect(input.onError).toHaveBeenCalled()
    }
  )
  it('a plain /clear never carries withdrawQueued — an incapable host is untouched', async () => {
    const { input, sendRequest } = setup()
    expect(await dispatchMobileStructuredCommand({ ...input, text: '/clear' })).toBe('accepted')
    const params = sendRequest.mock.calls[0]![1] as Record<string, unknown>
    expect('withdrawQueued' in params).toBe(false)
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
  })
  it('a capable /clear withdraws drafts, persists ahead, and restores the text once', async () => {
    const { input, sendRequest } = setup()
    sendRequest.mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        value: {
          command: 'clear',
          state: 'completed',
          withdrawnQueued: [
            {
              messageId: 'draft-1',
              body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'held' }] }
            }
          ]
        }
      }
    } as never)
    const appendText = vi.fn()
    const outcome = await dispatchMobileStructuredCommand({
      ...input,
      text: '/clear',
      clearWithdrawal: { draftKey: 'pane-1', appendText }
    })
    expect(outcome).toBe('accepted')
    const params = sendRequest.mock.calls[0]?.[1] as { withdrawQueued?: true }
    expect(params.withdrawQueued).toBe(true)
    // Write-ahead: the restore handle reached storage before the RPC left.
    expect(asyncStorage.setItem.mock.invocationCallOrder[0]).toBeLessThan(
      sendRequest.mock.invocationCallOrder[0]!
    )
    expect(appendText.mock.calls).toEqual([['pane-1', 'held']])
    // Settled: nothing left for a reload replay to restore again.
    expect(stored.size).toBe(0)
  })
  it('an unconfirmed capable /clear keeps its restore handle and replays the same id', async () => {
    const { input, sendRequest } = setup()
    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, value: { command: 'clear', state: 'unknown' } }
    } as never)
    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        value: { command: 'clear', state: 'completed', withdrawnQueued: [] }
      }
    } as never)
    const appendText = vi.fn()
    const withdrawal = { clearWithdrawal: { draftKey: 'pane-1', appendText } }
    expect(await dispatchMobileStructuredCommand({ ...input, text: '/clear', ...withdrawal })).toBe(
      'unknown'
    )
    expect(stored.size).toBe(1)
    expect(await dispatchMobileStructuredCommand({ ...input, text: '/clear', ...withdrawal })).toBe(
      'accepted'
    )
    expect(sendRequest.mock.calls[0]?.[1]).toEqual(sendRequest.mock.calls[1]?.[1])
    expect(stored.size).toBe(0)
  })
  it('keeps ordinary messages on the existing send path', async () => {
    const { input, sendRequest } = setup()
    expect(await dispatchMobileStructuredCommand({ ...input, text: 'hello' })).toBeNull()
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
