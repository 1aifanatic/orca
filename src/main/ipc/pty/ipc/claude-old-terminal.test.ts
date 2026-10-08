import { beforeEach, expect, it, vi } from 'vitest'
import { CLAUDE_ACCOUNT_FUNCTION_DAEMON_PROTOCOL_VERSION } from '../../../daemon/daemon-protocol-version'

type Handler = (event: unknown, args: { id: unknown }) => Promise<boolean>

type Mocks = {
  handlers: Map<string, Handler>
  olderPtyIds: Set<string>
  startup: ReturnType<typeof vi.fn<() => Promise<void> | undefined>>
  runsAnotherAccount: boolean | null
  router: boolean
}

const mocks = vi.hoisted((): Mocks => ({
  handlers: new Map(),
  olderPtyIds: new Set(),
  startup: vi.fn<() => Promise<void> | undefined>(),
  runsAnotherAccount: true,
  router: true
}))
vi.mock('../../pty-host-bindings', () => ({
  getPtyIpc: () => ({
    handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler)
  })
}))
vi.mock('../../../daemon/daemon-provider-state', () => ({
  isTerminalFromBeforeDaemonProtocol: (id: string, protocolVersion: number) =>
    protocolVersion === CLAUDE_ACCOUNT_FUNCTION_DAEMON_PROTOCOL_VERSION && mocks.olderPtyIds.has(id)
}))
vi.mock('../../../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () =>
    mocks.router ? { systemDefaultRunsAnotherAccount: () => mocks.runsAnotherAccount } : undefined
}))

import { installPtyClaudeOldTerminalIpcHandler } from './claude-old-terminal'

beforeEach(() => {
  mocks.handlers.clear()
  mocks.olderPtyIds = new Set(['old-1'])
  mocks.runsAnotherAccount = true
  mocks.router = true
  installPtyClaudeOldTerminalIpcHandler({ getLocalPtyProviderStartupPromise: mocks.startup })
})

it('answers true only for a pane owned by a daemon from before per-account Claude folders', async () => {
  const ask = mocks.handlers.get('pty:openedBeforeClaudeAccounts')!
  expect(await ask({}, { id: 'old-1' })).toBe(true)
  // A pane on this build's daemon, or an SSH pane, which no local daemon owns.
  expect(await ask({}, { id: 'new-1' })).toBe(false)
  expect(await ask({}, { id: 'ssh:conn-1:pty-1' })).toBe(false)
  expect(await ask({}, { id: 42 })).toBe(false)
  expect(mocks.startup).toHaveBeenCalled()
})

it("answers false when that pane's claude already runs the selected account", async () => {
  const ask = mocks.handlers.get('pty:openedBeforeClaudeAccounts')!
  mocks.runsAnotherAccount = false
  expect(await ask({}, { id: 'old-1' })).toBe(false)
  // With no host account selected (a WSL one), the router cannot tell; the pane still asks.
  mocks.runsAnotherAccount = null
  expect(await ask({}, { id: 'old-1' })).toBe(true)
  mocks.router = false
  expect(await ask({}, { id: 'old-1' })).toBe(true)
})
