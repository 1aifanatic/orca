import { beforeEach, describe, expect, it, vi } from 'vitest'

type TabsByWorktree = Record<string, { contentType: string; entityId: string }[]>

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  focusRenderer: vi.fn(),
  focusRuntime: vi.fn(),
  paneUnavailable: vi.fn(),
  activateChat: vi.fn(async () => true),
  gone: vi.fn(),
  hostCannotOpen: vi.fn(),
  unavailable: vi.fn(),
  tabs: new Map<string, TabsByWorktree>([['current', {}]])
}))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc: mocks.callRuntimeRpc,
  getActiveRuntimeTarget: ({
    activeRuntimeEnvironmentId
  }: {
    activeRuntimeEnvironmentId: string
  }) => ({ kind: 'environment', environmentId: activeRuntimeEnvironmentId })
}))
vi.mock('@/components/terminal-pane/terminal-handle-links', () => ({
  focusRendererTerminalHandle: mocks.focusRenderer,
  focusRuntimeTerminalHandle: mocks.focusRuntime
}))
vi.mock('@/components/terminal-pane/stale-agent-row', () => ({
  showAgentPaneUnavailable: mocks.paneUnavailable
}))
vi.mock('./activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.activateChat,
  structuredSessionOpenFeedback: {
    gone: mocks.gone,
    hostCannotOpen: mocks.hostCannotOpen,
    unavailable: mocks.unavailable
  }
}))
vi.mock('./worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => 'env-host'
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ unifiedTabsByWorktree: mocks.tabs.get('current') }) }
}))

import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { openAgentMessageSender } from './open-agent-message-sender'

const HOST = { kind: 'environment', environmentId: 'env-host' }
const ROOT = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const chat = { address: `orca_session_id:${ROOT}`, terminalHandle: null, orcaSessionId: ROOT }
const terminal = { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null }
const dispatch = { address: 'dispatch:d1', terminalHandle: 'dispatch:d1', orcaSessionId: null }

function failure(code: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({
    id: 'rpc_1',
    ok: false,
    error: { code, message: code },
    _meta: { runtimeId: 'runtime_1' }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.tabs.set('current', {})
})

describe("opening a message's sender", () => {
  it('focuses a terminal sender through the terminal-handle path, with no lookup', async () => {
    mocks.focusRenderer.mockReturnValue(true)
    await openAgentMessageSender(terminal, 'wt-chat')
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.focusRenderer).toHaveBeenCalledWith('term_a', 'env-host')
    expect(mocks.focusRuntime).not.toHaveBeenCalled()
  })

  it("asks the chat's host to focus a terminal this window does not show, and says so when it is gone", async () => {
    mocks.focusRenderer.mockReturnValue(false)
    mocks.focusRuntime.mockRejectedValue(new Error('terminal_not_found'))
    await openAgentMessageSender(terminal, 'wt-chat')
    expect(mocks.focusRuntime).toHaveBeenCalledWith('term_a', 'env-host')
    expect(mocks.paneUnavailable).toHaveBeenCalledTimes(1)
  })

  it("opens a chat sender at its live session through the open-chat flow, asking the chat's host", async () => {
    mocks.callRuntimeRpc.mockResolvedValue({
      location: { kind: 'chat', sessionId: 'live-session', worktreeId: 'wt-sender' }
    })
    await openAgentMessageSender(chat, 'wt-chat')
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(HOST, 'orchestration.partyLocation', {
      address: chat.address
    })
    expect(mocks.activateChat).toHaveBeenCalledWith({
      structuredSession: { workspaceId: 'wt-sender', sessionId: 'live-session' }
    })
  })

  it("resolves a dispatch sender on the host, to its assignee's terminal", async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ location: { kind: 'terminal', handle: 'term_w' } })
    mocks.focusRenderer.mockReturnValue(true)
    await openAgentMessageSender(dispatch, 'wt-chat')
    expect(mocks.focusRenderer).toHaveBeenCalledWith('term_w', 'env-host')
  })

  it('gives the existing feedback for a sender the host no longer knows', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ location: null })
    await openAgentMessageSender(chat, 'wt-chat')
    expect(mocks.gone).toHaveBeenCalledTimes(1)
    await openAgentMessageSender(dispatch, 'wt-chat')
    expect(mocks.paneUnavailable).toHaveBeenCalledTimes(1)
    expect(mocks.activateChat).not.toHaveBeenCalled()
  })

  it('says the host could not be reached rather than that the sender is gone', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(new Error('socket closed'))
    await openAgentMessageSender(chat, 'wt-chat')
    expect(mocks.unavailable).toHaveBeenCalledTimes(1)
    expect(mocks.gone).not.toHaveBeenCalled()
  })

  it('on a host before the lookup, opens a chat this window shows under its id, else asks for an update', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(failure('method_not_found'))
    mocks.tabs.set('current', { 'wt-sender': [{ contentType: 'agent-session', entityId: ROOT }] })
    await openAgentMessageSender(chat, 'wt-chat')
    expect(mocks.activateChat).toHaveBeenCalledWith({
      structuredSession: { workspaceId: 'wt-sender', sessionId: ROOT }
    })
    mocks.tabs.set('current', {})
    await openAgentMessageSender(chat, 'wt-chat')
    expect(mocks.hostCannotOpen).toHaveBeenCalledTimes(1)
  })

  it('runs one open per sender at a time', async () => {
    let answer: (value: unknown) => void = () => {}
    mocks.callRuntimeRpc.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const first = openAgentMessageSender(chat, 'wt-chat')
    const second = openAgentMessageSender(chat, 'wt-chat')
    answer({ location: null })
    await Promise.all([first, second])
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
  })
})
