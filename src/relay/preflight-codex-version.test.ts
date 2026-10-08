import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../shared/codex-cli-installation'
import { RelayDispatcher } from './dispatcher'
import { PreflightHandler } from './preflight-handler'

const { lookup, readInstallation } = vi.hoisted(() => ({
  lookup: vi.fn(),
  readInstallation: vi.fn()
}))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: lookup })
}))
vi.mock('../main/preflight/codex-cli-installation', () => ({
  readCodexCliInstallation: readInstallation
}))
vi.mock('../main/pwsh', () => ({ isPwshAvailableAsync: vi.fn() }))
vi.mock('../main/wsl', () => ({ isWslAvailableAsync: vi.fn(), listWslDistrosAsync: vi.fn() }))
vi.mock('../main/git-bash', () => ({ isGitBashAvailable: vi.fn() }))

const dispatchers: RelayDispatcher[] = []
function handler() {
  const dispatcher = new RelayDispatcher(() => {})
  dispatchers.push(dispatcher)
  const registered = vi.spyOn(dispatcher, 'onRequest')
  new PreflightHandler(dispatcher)
  const found = registered.mock.calls.find(([method]) => method === 'preflight.detectAgents')?.[1]
  if (!found) {
    throw new Error('Agent detector was not registered')
  }
  return (commands: { id: string; cmd: string; reportVersion?: true }[]) =>
    found({ commands }, { clientId: 1, isStale: () => false })
}
beforeEach(() => {
  lookup.mockReset()
  readInstallation.mockReset()
  lookup.mockResolvedValue({ stdout: '__ORCA_AGENT_PATH__/execution-host/bin/codex\n' })
})
afterEach(() => {
  for (const dispatcher of dispatchers.splice(0)) {
    dispatcher.dispose()
  }
})

describe('relay Codex version reporting', () => {
  it('reads the version of the binary resolved on the relay host', async () => {
    readInstallation.mockResolvedValue(codexCliInstallation(true, '0.135.0'))
    await expect(handler()([{ id: 'codex', cmd: 'codex', reportVersion: true }])).resolves.toEqual({
      agents: ['codex'],
      versions: { codex: '0.135.0' }
    })
    expect(readInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ program: '/execution-host/bin/codex' })
    )
  })

  it('keeps ordinary detection unchanged and does not probe a missing binary', async () => {
    const detect = handler()
    await expect(detect([{ id: 'codex', cmd: 'codex' }])).resolves.toEqual({ agents: ['codex'] })
    lookup.mockResolvedValue({ stdout: '' })
    await expect(detect([{ id: 'codex', cmd: 'codex', reportVersion: true }])).resolves.toEqual({
      agents: []
    })
    expect(readInstallation).not.toHaveBeenCalled()
  })

  it('omits an unknown version so mixed-version clients can still read the detector response', async () => {
    readInstallation.mockResolvedValue(codexCliInstallation(true, null))
    await expect(handler()([{ id: 'codex', cmd: 'codex', reportVersion: true }])).resolves.toEqual({
      agents: ['codex']
    })
  })
})
