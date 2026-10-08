// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentSessionRefusalFailure } from '../../../../shared/agent-session-write-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'
import { codexCliInstallation } from '../../../../shared/codex-cli-installation'
import {
  codexMaintenanceAction,
  type CodexMaintenanceState
} from '../../../../shared/codex-cli-maintenance'
import {
  refreshCodexMaintenance,
  resetCodexMaintenanceStoreForTests
} from '@/lib/codex-maintenance-store'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import type * as CodexMaintenanceClient from '@/lib/codex-maintenance-client'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)
const { call } = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/lib/codex-maintenance-client', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexMaintenanceClient>()),
  callCodexMaintenance: call
}))
vi.mock('@/lib/structured-agent-session-launch', () =>
  moduleFactories.structuredAgentSessionLaunch()
)
vi.mock('@/lib/structured-agent-session-launch-message', () =>
  moduleFactories.structuredAgentSessionLaunchMessage()
)
vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', async () => {
  const factory = await moduleFactories.useStructuredAgentSession()
  return {
    useStructuredAgentSession: (...args: Parameters<typeof factory.useStructuredAgentSession>) => {
      const controller = factory.useStructuredAgentSession(...args)
      return {
        ...controller,
        queuedMessages: { ...controller.queuedMessages, resume: mocks.queuedResume }
      }
    }
  }
})
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-tab-owner', () => moduleFactories.useNativeChatTabOwner())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatMessageList', () => ({
  NativeChatMessageList: () => (
    <>
      {projectStructuredItemsToNativeChat(mocks.journalItems).map((message) => (
        <div key={message.id}>
          {message.blocks.map((block) =>
            block.type === 'text' ? <NativeChatNoticeRow key={block.text} block={block} /> : null
          )}
        </div>
      ))}
    </>
  )
}))

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

const target = { kind: 'local', cwd: '/repo' } as const
const originalSettings = useAppStore.getState().settings
function state(version: string | null): CodexMaintenanceState {
  const installation = codexCliInstallation(version !== null, version)
  return {
    installation,
    action: codexMaintenanceAction(installation, false),
    canRun: true,
    job: null,
    evidence: { expiresAt: Date.now() + 30_000, configurationId: 'config' }
  }
}
function refuse(installedVersion: string | null = '0.135.0') {
  mocks.launchLifecycle = 'failed'
  mocks.launchFailure = agentSessionRefusalFailure({
    code: 'agent_session_operation_invalid',
    details: {
      reason: 'attachFailed',
      codexInstallation: { installedVersion, minimumVersion: '0.136.0' }
    }
  })
}
function retainRow() {
  mocks.journalItems = [
    {
      itemId: agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('old-start')),
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(
          {
            kind: 'startFailed',
            refusal: {
              code: 'agent_session_operation_invalid',
              details: {
                reason: 'attachFailed',
                codexInstallation: { installedVersion: '0.135.0', minimumVersion: '0.136.0' }
              }
            }
          },
          { agentName: 'Codex', surface: 'row' }
        )
      }
    }
  ]
}
function pane() {
  return (
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="codex-tab"
      sessionId="session-1"
      target={{ kind: 'local' }}
      agent="codex"
    />
  )
}
async function check() {
  await act(async () => {
    await refreshCodexMaintenance(target)
  })
}
beforeEach(() => {
  resetStructuredSessionMocks()
  resetCodexMaintenanceStoreForTests()
  call.mockReset()
  useAppStore.setState({ settings: getDefaultSettings('/tmp') })
})
afterEach(() => {
  cleanup()
  resetCodexMaintenanceStoreForTests()
  useAppStore.setState({ settings: originalSettings })
})

it.each([null, '0.135.0'])(
  'gives an immediately refused tab the same composer notice for %s',
  async (version) => {
    refuse(version)
    call.mockResolvedValue(state(version))
    render(pane())
    await check()
    expect(
      screen.getByText(version === null ? 'Codex not installed' : 'Codex update required')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        version === null
          ? "Codex isn't installed."
          : 'Codex 0.135.0 is too old for chats. Update to 0.136.0 or newer.'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: version === null ? 'Install Codex' : 'Update Codex' })
    ).toBeEnabled()
    expect(
      screen.queryByText(/Chat could not be started|selected installation|on this host|Settings/)
    ).toBeNull()
    expect(mocks.composerProps?.structuredTransport?.sendOut).toBe(true)
  }
)

it('automatically retries the refused chat once after the update exits and the host recheck is ready', async () => {
  refuse()
  const old = state('0.135.0')
  const action = old.action
  if (!action) {
    throw new Error('No action')
  }
  const completed: CodexMaintenanceState = {
    ...state('0.136.0'),
    currentJob: null,
    job: { id: 'updated', phase: 'completed', action, output: 'updated', exitCode: 0, error: null }
  }
  call.mockImplementation(async (_target, params) =>
    params.operation === 'start' ? completed : old
  )
  const view = render(pane())
  await check()
  fireEvent.click(screen.getByRole('button', { name: 'Update Codex' }))
  await waitFor(() =>
    expect(mocks.retryLaunch).toHaveBeenCalledExactlyOnceWith('wt-1', 'session-1')
  )
  expect(screen.queryByText(/too old/)).toBeNull()
  expect(screen.getByText('Codex is updated. Retry.')).toBeInTheDocument()
  // The retry can fail on an account-specific selection; one unchanged check must not loop.
  if (!mocks.launchFailure) {
    throw new Error('No refusal')
  }
  mocks.launchFailure = { ...mocks.launchFailure }
  view.rerender(pane())
  expect(mocks.retryLaunch).toHaveBeenCalledOnce()
  mocks.launchLifecycle = 'pending'
  view.rerender(pane())
  expect(screen.queryByText('Codex is updated. Retry.')).toBeNull()
  mocks.launchLifecycle = null
  view.rerender(pane())
  expect(mocks.composerProps?.structuredTransport?.sendOut).toBeFalsy()
})

it.each(['0.135.0', null])(
  'keeps a recovered running chat usable after Command selects %s with the refusal row retained',
  async (version) => {
    refuse()
    retainRow()
    call.mockResolvedValue(state('0.136.0'))
    const view = render(pane())
    await check()
    expect(mocks.retryLaunch).toHaveBeenCalledOnce()
    mocks.launchLifecycle = null
    mocks.launchFailure = null
    view.rerender(pane())
    call.mockResolvedValue(state(version))
    act(() =>
      useAppStore.setState({
        settings: { ...getDefaultSettings('/tmp'), agentCmdOverrides: { codex: '/older/codex' } }
      })
    )
    await check()
    expect(mocks.journalItems).toHaveLength(1)
    expect(mocks.composerProps?.structuredTransport?.sendOut).toBeFalsy()
    const send = mocks.composerProps?.structuredTransport?.send
    if (typeof send !== 'function') {
      throw new Error('Missing send')
    }
    expect(send('still running', [])).toBe(true)
    expect(mocks.send).toHaveBeenCalledWith('still running', [])
    expect(mocks.retryLaunch).toHaveBeenCalledOnce()
  }
)

it('replaces a journal-only refusal with the ready retry action without replaying rejected messages', async () => {
  retainRow()
  call.mockResolvedValue(state('0.136.0'))
  render(pane())
  await check()
  expect(screen.queryByText(/too old/)).toBeNull()
  expect(screen.getByText('Codex is updated. Retry.')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(mocks.queuedResume).toHaveBeenCalledOnce()
  expect(mocks.retryLaunch).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
})

it('does not automatically retry an unrelated start failure or an unknown check', async () => {
  refuse()
  call.mockResolvedValue({ ...state('0.136.0'), installation: codexCliInstallation(true, null) })
  const view = render(pane())
  await check()
  expect(mocks.retryLaunch).not.toHaveBeenCalled()
  mocks.launchFailure = agentSessionRefusalFailure({
    code: 'agent_session_operation_invalid',
    details: { reason: 'notSignedIn' }
  })
  view.rerender(pane())
  expect(mocks.retryLaunch).not.toHaveBeenCalled()
})

it.each(['live', 'unverifiable'] as const)(
  'leaves an ownership refusal explicit when the prior owner is %s',
  async (ownerVerdict) => {
    mocks.launchLifecycle = 'failed'
    mocks.launchFailure = agentSessionRefusalFailure({
      code: 'agent_session_ownership_unknown',
      details: { reason: 'ownerUnproven', ownerVerdict }
    })
    call.mockResolvedValue(state('0.136.0'))
    render(pane())
    await check()
    expect(screen.queryByText('Codex is updated. Retry.')).toBeNull()
    expect(mocks.retryLaunch).not.toHaveBeenCalled()
  }
)

it('rearms recovery when a later check proves Codex old again before another update', async () => {
  refuse()
  call.mockResolvedValue(state('0.136.0'))
  render(pane())
  await check()
  expect(mocks.retryLaunch).toHaveBeenCalledOnce()
  call.mockResolvedValue(state('0.135.0'))
  await check()
  call.mockResolvedValue(state('0.136.0'))
  await check()
  expect(mocks.retryLaunch).toHaveBeenCalledTimes(2)
})
