import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { dispatchMobileStructuredCommand } from './mobile-structured-composer-command'

function setup() {
  const sendRequest = vi.fn(
    async (_method: string, _params: unknown, _options: unknown): Promise<unknown> => ({
      ok: true,
      result: { ok: true, value: { command: 'compact', state: 'completed' } }
    })
  )
  const input: Parameters<typeof dispatchMobileStructuredCommand>[0] = {
    text: '/compact',
    hasAttachments: false,
    client: { sendRequest } as unknown as RpcClient,
    sessionId: 'session',
    fence: 1,
    pending: { current: false },
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
    }
  )
  it.each([
    [
      'the host reports the command unconfirmed',
      { ok: true, result: { ok: true, value: { command: 'compact', state: 'unknown' } } }
    ],
    [
      'the host cannot say what became of it',
      {
        ok: true,
        result: {
          ok: false,
          refusal: { code: 'agent_session_operation_unknown', message: 'unconfirmed' }
        }
      }
    ],
    [
      'the host fails after starting it',
      { ok: false, error: { code: 'runtime_error', message: 'settlement failed' } }
    ]
  ])('sends the next press as a new command after %s', async (_case, answer) => {
    const { input, sendRequest } = setup()
    sendRequest.mockResolvedValueOnce(answer)
    expect(await dispatchMobileStructuredCommand(input)).toBe('unknown')
    expect(await dispatchMobileStructuredCommand(input)).toBe('accepted')
    // Only the operation id differs between the two requests.
    expect(sendRequest.mock.calls[1]?.[1]).not.toEqual(sendRequest.mock.calls[0]?.[1])
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
  it('keeps ordinary messages on the existing send path', async () => {
    const { input, sendRequest } = setup()
    expect(await dispatchMobileStructuredCommand({ ...input, text: 'hello' })).toBeNull()
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
