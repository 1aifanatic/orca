// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../../../../shared/codex-cli-installation'
import {
  codexMaintenanceAction,
  type CodexMaintenanceState
} from '../../../../shared/codex-cli-maintenance'
import { useCodexMaintenance } from '@/hooks/useCodexMaintenance'
import {
  refreshCodexMaintenance,
  resetCodexMaintenanceStoreForTests
} from '@/lib/codex-maintenance-store'
import { CodexMaintenanceRow } from '../settings/CodexMaintenanceRow'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'
import { CodexMaintenanceLogDialog } from './CodexMaintenanceLogDialog'

const { call, refreshAgents } = vi.hoisted(() => ({
  call: vi.fn(),
  refreshAgents: vi.fn().mockResolvedValue([])
}))
vi.mock('@/lib/codex-maintenance-client', () => ({
  callCodexMaintenance: call,
  codexMaintenanceTargetKey: (target: { kind: string; cwd?: string }) =>
    `${target.kind}:codex${target.cwd ? `:${target.cwd}` : ''}`
}))
vi.mock('@/store', () => ({
  useAppStore: {
    subscribe: () => () => {},
    getState: () => ({
      refreshDetectedAgents: refreshAgents,
      sshConnectionStates: new Map([['offline', { status: 'disconnected' }]])
    })
  }
}))
const TARGET = { kind: 'local' } as const
function state(installed: boolean, version: string | null, canRun = true): CodexMaintenanceState {
  const installation = codexCliInstallation(installed, version)
  return {
    evidence: { expiresAt: Date.now() + 30_000, configurationId: 'config' },
    installation,
    action: codexMaintenanceAction(installation, false),
    canRun,
    job: null
  }
}
function Composer() {
  const maintenance = useCodexMaintenance(TARGET)
  return (
    <>
      <NativeChatComposerNotices notices={maintenance.notice ? [maintenance.notice] : []} />
      <button disabled={maintenance.blocked}>Send</button>
      <CodexMaintenanceLogDialog />
    </>
  )
}
beforeEach(() => {
  call.mockReset()
  resetCodexMaintenanceStoreForTests()
})
afterEach(() => {
  cleanup()
  resetCodexMaintenanceStoreForTests()
  vi.useRealTimers()
})
async function flush() {
  await act(async () => {
    await refreshCodexMaintenance(TARGET)
  })
}

import { agentSessionRefusalFailure } from '../../../../shared/agent-session-write-failure'
import { structuredSessionNotices } from './native-chat-structured-session-notices'
describe('Codex failure and manual repair copy', () => {
  it.each([
    { error: 'spawn C:\\tools\\node.exe EACCES', exitCode: null },
    { error: 'Codex maintenance timed out.', exitCode: null },
    { error: null, exitCode: 17 }
  ])(
    'renders and copies the host diagnostic with error $error and exit $exitCode',
    async ({ error, exitCode }) => {
      const initial = state(false, null)
      if (!initial.action) {
        throw new Error('No action')
      }
      const diagnostic = error ?? 'npm ERR! EACCES: permission denied'
      const output = `$ npm install -g @openai/codex\n${diagnostic}\n`
      const completed: CodexMaintenanceState = {
        ...initial,
        job: { id: 'failed', phase: 'completed', action: initial.action, output, error, exitCode }
      }
      call.mockImplementation(async (_target, params) =>
        params.operation === 'start' ? completed : initial
      )
      const write = vi.fn().mockResolvedValue(undefined)
      Object.assign(window, { api: { ui: { writeClipboardText: write } } })
      render(<Composer />)
      await flush()
      fireEvent.click(screen.getByRole('button', { name: 'Install Codex' }))
      expect(
        await screen.findByText(
          error ? 'Codex could not be installed. Try again.' : 'Command exited with code 17'
        )
      ).toBeInTheDocument()
      expect(
        screen.getByText((text) => text.includes(diagnostic), { selector: 'pre' })
      ).toHaveTextContent(diagnostic)
      fireEvent.click(screen.getByRole('button', { name: 'Copy log' }))
      await waitFor(() => expect(write).toHaveBeenCalledExactlyOnceWith(output))
    }
  )
  it('shows an exact manual command when repair cannot run here', async () => {
    call.mockResolvedValue(state(true, '0.135.0', false))
    render(
      <>
        <Composer />
        <CodexMaintenanceRow target={TARGET} />
      </>
    )
    await flush()
    expect(screen.getAllByText('Run codex update.')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Update Codex' })).toBeNull()
  })
  it('keeps a raw start error out of the failure headline', async () => {
    call.mockImplementation(async (_target, params) => {
      if (params.operation === 'start') {
        throw new Error('private transport stack and host runtime details')
      }
      return state(true, '0.135.0')
    })
    render(<Composer />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Update Codex' }))
    expect(await screen.findByText('Codex could not be updated. Try again.')).toBeInTheDocument()
    expect(screen.queryByText(/private transport stack/)).toBeNull()
  })
  it('adds Update to the existing start-failure notice while retaining Retry for other failures', () => {
    const action = { label: 'Update Codex', onClick: vi.fn() }
    const notices = structuredSessionNotices({
      agentLabel: 'Codex',
      sessionError: null,
      composerError: null,
      launch: {
        lifecycle: 'failed',
        retry: vi.fn(),
        failure: agentSessionRefusalFailure({
          code: 'agent_session_operation_invalid',
          details: {
            reason: 'attachFailed',
            codexInstallation: { installedVersion: '0.135.0', minimumVersion: '0.136.0' }
          }
        })
      },
      codexMaintenanceAction: action
    })
    render(<NativeChatComposerNotices notices={notices} />)
    expect(screen.getByRole('button', { name: 'Update Codex' })).toBeEnabled()
    expect(screen.getByText('Codex update required')).toBeInTheDocument()
    expect(
      screen.getByText('Codex 0.135.0 is too old for chats. Update to 0.136.0 or newer.')
    ).toBeInTheDocument()
  })
})
