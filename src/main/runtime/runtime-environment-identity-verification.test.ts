import { afterEach, describe, expect, it, vi } from 'vitest'
import { PAIRING_OFFER_VERSION } from '../../shared/pairing'

const sendRemoteRuntimeRequest = vi.hoisted(() => vi.fn())
vi.mock('../../shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest }))
vi.mock('../../shared/remote-pairing-verification', () => ({
  verifyRemotePairingRuntimeStatus: (runtimeStatus: unknown) => ({ ok: true, runtimeStatus })
}))

const { RUNTIME_IDENTITY_MISMATCH_MESSAGE, verifyRuntimePairingIdentity } =
  await import('./runtime-environment-identity-verification')

const pairing = {
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://127.0.0.1:46768',
  deviceToken: 'token-new',
  publicKeyB64: 'public-key'
}

function answers(runtimeId: string, pairedDeviceId: string): void {
  sendRemoteRuntimeRequest.mockResolvedValue({
    ok: true,
    result: { runtimeId, pairedDeviceId },
    _meta: { runtimeId }
  })
}

afterEach(() => vi.restoreAllMocks())

describe('verifyRuntimePairingIdentity after a re-pair', () => {
  it('accepts the runtime once the saved device matches the re-paired token', async () => {
    answers('runtime-1', 'device-new')
    await expect(
      verifyRuntimePairingIdentity(pairing, {
        runtimeId: 'runtime-1',
        pairedDeviceId: 'device-new'
      })
    ).resolves.toMatchObject({ verifiedRuntimeId: 'runtime-1' })
  })

  it('reads a device-id-only difference as a stale pairing, not another server', async () => {
    answers('runtime-1', 'device-new')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      verifyRuntimePairingIdentity(pairing, {
        runtimeId: 'runtime-1',
        pairedDeviceId: 'device-old'
      })
    ).resolves.toMatchObject({ runtimeStatus: { pairedDeviceId: 'device-new' } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pairing is stale'))
  })

  it('still refuses a different runtime', async () => {
    answers('runtime-2', 'device-new')
    await expect(
      verifyRuntimePairingIdentity(pairing, {
        runtimeId: 'runtime-1',
        pairedDeviceId: 'device-new'
      })
    ).rejects.toThrow(RUNTIME_IDENTITY_MISMATCH_MESSAGE)
  })
})
