import { describe, expect, it, vi } from 'vitest'
import { createAgentSessionCreateOperation } from './agent-session-create-operation'
import { RuntimeRpcCallError } from './runtime-rpc-result'

function rpcFailure(code: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({ id: 'request', ok: false, error: { code, message: code } })
}

describe('createAgentSessionCreateOperation', () => {
  it.each(['runtime_timeout', 'remote_runtime_unavailable'])(
    'replays under the same operation id when the desktop bridge reports %s',
    async (code) => {
      const invoke = vi
        .fn()
        .mockRejectedValueOnce(rpcFailure(code))
        .mockResolvedValueOnce('created')

      await expect(createAgentSessionCreateOperation().run(invoke)).resolves.toBe('created')
      expect(invoke).toHaveBeenCalledTimes(2)
      expect(invoke.mock.calls[1][0]).toBe(invoke.mock.calls[0][0])
    }
  )

  it('does not replay an answer the host gave', async () => {
    const invoke = vi.fn().mockRejectedValue(rpcFailure('agent_session_operation_conflict'))

    await expect(createAgentSessionCreateOperation().run(invoke)).rejects.toMatchObject({
      code: 'agent_session_operation_conflict'
    })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('still replays a thrown transport error', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce('created')

    await expect(createAgentSessionCreateOperation().run(invoke)).resolves.toBe('created')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
