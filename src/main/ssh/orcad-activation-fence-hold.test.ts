import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ stale: vi.fn(), journal: vi.fn(), fence: vi.fn() }))
vi.mock('./ssh-relay-install-lock', () => ({
  isRelayInstallLockStale: mocks.stale,
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))
vi.mock('./orcad-activation-transaction-store', () => ({
  readOrcadActivationTransaction: mocks.journal
}))
vi.mock('./orcad-activation-lock', () => ({
  orcadActivationFenceExists: mocks.fence,
  orcadActivationTransactionRoot: () => '/home/u/.orca-remote/.orcad-activation-transaction'
}))

const { orcadActivationFenceRefusal } = await import('./orcad-activation-fence-hold')
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every reader of these options is mocked.
const options = { host: { os: 'linux', pathFlavor: 'posix' }, remoteHome: '/home/u' } as never

beforeEach(() => {
  vi.resetAllMocks()
  mocks.stale.mockResolvedValue(false)
  mocks.journal.mockResolvedValue(null)
  mocks.fence.mockResolvedValue(true)
})

describe('orcadActivationFenceRefusal', () => {
  it('reads a fresh fence as busy, even over a live run journal', async () => {
    mocks.journal.mockResolvedValue({ operation: 'activate' })
    await expect(orcadActivationFenceRefusal(options, 'update')).resolves.toMatchObject({
      code: 'orcad_activation_fence_busy'
    })
  })

  it('asks for Recover only for a stale lock or a journal no fence guards', async () => {
    mocks.stale.mockResolvedValueOnce(true)
    await expect(orcadActivationFenceRefusal(options, 'update')).resolves.toMatchObject({
      code: 'orcad_activation_recovery_required'
    })
    mocks.journal.mockResolvedValue({ operation: 'activate' })
    mocks.fence.mockResolvedValue(false)
    await expect(orcadActivationFenceRefusal(options, 'update')).resolves.toMatchObject({
      code: 'orcad_activation_recovery_required'
    })
  })
})
