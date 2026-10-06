import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendRuntimePtyInputVerified } from './runtime-terminal-verified-input'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const REMOTE_PTY = 'remote:env-1@@terminal-1'
const runtimeSend = vi.fn()
const localWrite = vi.fn()
const localWriteAccepted = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: (args: RuntimeEnvironmentCallRequest) =>
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeSend(args)
      },
      pty: { write: localWrite, writeAccepted: localWriteAccepted }
    }
  })
})

function hostReply(send: Record<string, unknown>) {
  runtimeSend.mockResolvedValue({
    ok: true,
    result: { send: { handle: 'terminal-1', bytesWritten: 1, ...send } },
    _meta: { runtimeId: 'runtime-1' }
  })
}

describe('verified input that requires provider settlement', () => {
  it.each([
    ['older host whole-write', { accepted: true }, true],
    ['acknowledged', { accepted: true, writeSettlement: { outcome: 'accepted' } }, true],
    [
      'refused',
      { accepted: false, writeSettlement: { outcome: 'refused', reason: 'endpoint_disconnected' } },
      false
    ]
  ] as const)('reads the %s remote verdict', async (_label, send, accepted) => {
    hostReply(send)
    await expect(
      sendRuntimePtyInputVerified(null, REMOTE_PTY, 'x', 'driving', {
        requireWriteSettlement: true
      })
    ).resolves.toBe(accepted)
    expect(runtimeSend).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.send',
        params: expect.objectContaining({ requireWriteSettlement: true })
      })
    )
  })

  it('rejects a remote send whose settlement is unverifiable, without a fallback write', async () => {
    hostReply({
      accepted: false,
      writeSettlement: {
        outcome: 'unverifiable',
        reason: 'transport_settlement_lost',
        bytesHandedToTransport: true
      }
    })
    await expect(
      sendRuntimePtyInputVerified(null, REMOTE_PTY, 'x', 'driving', {
        requireWriteSettlement: true
      })
    ).rejects.toThrow('acknowledgment unavailable')
    expect(localWrite).not.toHaveBeenCalled()
    expect(runtimeSend).toHaveBeenCalledOnce()
  })
})
