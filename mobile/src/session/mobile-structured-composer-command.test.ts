import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import { dispatchMobileStructuredCommand } from './mobile-structured-composer-command'
import { resetQueuedRestoreJournalForTests } from './mobile-structured-queued-restore-journal'

function setup() {
  const sendRequest = vi.fn<
    (method: string, params: unknown, options: unknown) => Promise<unknown>
  >(async () => ({
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
/** The fields one recorded request carried, read without asserting their shape. */
function requestFields(call: readonly unknown[] | undefined): Record<string, unknown> {
  const params = call?.[1]
  return typeof params === 'object' && params !== null
    ? Object.fromEntries(Object.entries(params))
    : {}
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
    expect('withdrawQueued' in requestFields(sendRequest.mock.calls[0])).toBe(false)
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
    })
    const appendText = vi.fn()
    const outcome = await dispatchMobileStructuredCommand({
      ...input,
      text: '/clear',
      clearWithdrawal: { draftKey: 'pane-1', appendText }
    })
    expect(outcome).toBe('accepted')
    expect(requestFields(sendRequest.mock.calls[0]).withdrawQueued).toBe(true)
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
    })
    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        value: { command: 'clear', state: 'completed', withdrawnQueued: [] }
      }
    })
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
  it('a capable /clear whose answer is lost re-asks the same id and restores once', async () => {
    const { input, sendRequest } = setup()
    sendRequest.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('Connection closed')))
    sendRequest.mockResolvedValueOnce({
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
    })
    const appendText = vi.fn()
    expect(
      await dispatchMobileStructuredCommand({
        ...input,
        text: '/clear',
        clearWithdrawal: { draftKey: 'pane-1', appendText }
      })
    ).toBe('accepted')
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(sendRequest.mock.calls[0]?.[1]).toEqual(sendRequest.mock.calls[1]?.[1])
    expect(appendText.mock.calls).toEqual([['pane-1', 'held']])
    expect(stored.size).toBe(0)
  })
  it('keeps ordinary messages on the existing send path', async () => {
    const { input, sendRequest } = setup()
    expect(await dispatchMobileStructuredCommand({ ...input, text: 'hello' })).toBeNull()
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
