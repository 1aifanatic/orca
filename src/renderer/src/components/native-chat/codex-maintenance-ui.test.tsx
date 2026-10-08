// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../../../../shared/codex-cli-installation'
import { agentSessionRefusalFailure } from '../../../../shared/agent-session-write-failure'
import {
  codexMaintenanceAction,
  codexMaintenanceManualAction,
  CodexMaintenanceStateSchema,
  type CodexMaintenanceState
} from '../../../../shared/codex-cli-maintenance'
import type { CodexMaintenanceTarget } from '@/lib/codex-maintenance-client'
import { useCodexMaintenance } from '@/hooks/useCodexMaintenance'
import {
  refreshCodexMaintenance,
  resetCodexMaintenanceStoreForTests
} from '@/lib/codex-maintenance-store'
import { CodexMaintenanceRow } from '../settings/CodexMaintenanceRow'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'
import { CodexMaintenanceLogDialog } from './CodexMaintenanceLogDialog'
import { structuredSessionNotices } from './native-chat-structured-session-notices'

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
function Composer({ target = TARGET }: { target?: CodexMaintenanceTarget } = {}) {
  const maintenance = useCodexMaintenance(target)
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

describe('Codex composer and Settings maintenance', () => {
  it('does not block on a completed installation response from a host whose contact is down', async () => {
    call.mockResolvedValue(state(true, '0.135.0'))
    const target = { kind: 'ssh', connectionId: 'offline' } as const
    render(<Composer target={target} />)
    await act(async () => {
      await refreshCodexMaintenance(target)
    })
    expect(screen.getByText('Send')).toBeEnabled()
    expect(screen.queryByText('Codex update required')).not.toBeInTheDocument()
  })

  it.each([
    {
      installed: false,
      version: null,
      title: 'Codex not installed',
      action: 'Install Codex',
      blocked: true
    },
    {
      installed: true,
      version: '0.135.0',
      title: 'Codex update required',
      action: 'Update Codex',
      blocked: true
    },
    { installed: true, version: null, title: null, action: null, blocked: false },
    { installed: true, version: '0.136.0', title: null, action: null, blocked: false }
  ])('renders known installation facts, allows unknown: $version / $installed', async (f) => {
    call.mockResolvedValue(state(f.installed, f.version))
    render(<Composer />)
    await flush()
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', f.blocked)
    if (f.title && f.action) {
      expect(screen.getByText(f.title)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: f.action })).toBeEnabled()
    } else {
      expect(screen.queryByRole('listitem')).toBeNull()
    }
  })
  it('renders a localized manual instruction while retaining readable text for legacy readers', async () => {
    const initial = CodexMaintenanceStateSchema.parse({
      ...state(true, '0.100.0', false),
      action: codexMaintenanceManualAction('/selected/codex', '0.136.0')
    })
    call.mockResolvedValue(initial)
    render(
      <>
        <Composer />
        <CodexMaintenanceRow target={TARGET} />
      </>
    )
    await flush()
    expect(
      screen.getAllByText(
        'Install or update Codex at /selected/codex to 0.136.0 or newer, then try again.'
      )
    ).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Update Codex' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })
  it('allows an older relay response without current evidence', async () => {
    const legacy = state(true, '0.135.0', false)
    delete legacy.evidence
    call.mockResolvedValue(legacy)
    render(<Composer />)
    await flush()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    expect(screen.queryByText('Codex update required')).toBeNull()
  })
  it.each([
    { installed: false, version: null, text: 'Not installed', action: 'Install Codex' },
    {
      installed: true,
      version: '0.135.0',
      text: 'Update required (installed 0.135.0, needs 0.136.0)',
      action: 'Update Codex'
    },
    { installed: true, version: null, text: null, action: null },
    { installed: true, version: '0.136.0', text: null, action: null }
  ])('uses the same action in the existing Settings row: $version / $installed', async (f) => {
    call.mockResolvedValue(state(f.installed, f.version))
    const view = render(<CodexMaintenanceRow target={TARGET} />)
    await flush()
    if (f.text && f.action) {
      expect(screen.getByText(f.text)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: f.action })).toBeEnabled()
    } else {
      expect(view.container.textContent).toBe('')
    }
  })
  it('joins a shared host job, shows busy labels and streams a failure log with its exit code', async () => {
    const initial = state(false, null)
    const action = initial.action
    if (!action) {
      throw new Error('Missing action')
    }
    const running: CodexMaintenanceState = {
      ...initial,
      job: {
        id: 'job',
        phase: 'running',
        action,
        output: '$ npm install -g @openai/codex\nstarted\n',
        exitCode: null,
        error: null
      }
    }
    const failed: CodexMaintenanceState = {
      ...running,
      currentJob: null,
      job: {
        ...running.job!,
        phase: 'completed',
        output: `${running.job!.output}permission denied\n`,
        exitCode: 7,
        error: null
      }
    }
    call.mockImplementation(async (_target, params) =>
      params.operation === 'status' ? initial : params.operation === 'start' ? running : failed
    )
    render(
      <>
        <Composer target={{ kind: 'local', cwd: '/project' }} />
        <CodexMaintenanceRow target={TARGET} />
      </>
    )
    await flush()
    fireEvent.click(screen.getAllByRole('button', { name: 'Install Codex' })[0])
    await waitFor(() =>
      expect(screen.getAllByText('Installing…', { selector: 'button' })).toHaveLength(2)
    )
    expect(screen.getByText(/started/)).toBeInTheDocument()
    await waitFor(
      () => expect(screen.getByText('Command exited with code 7')).toBeInTheDocument(),
      { timeout: 3000 }
    )
    expect(screen.getByText(/permission denied/)).toBeInTheDocument()
    expect(call.mock.calls.filter(([, p]) => p.operation === 'start')).toHaveLength(1)
  })
  it('clears both notices after successful host verification', async () => {
    const initial = state(false, null)
    const action = initial.action
    if (!action) {
      throw new Error('Missing action')
    }
    const running: CodexMaintenanceState = {
      ...initial,
      job: {
        id: 'job',
        phase: 'running',
        action,
        output: 'installing',
        exitCode: null,
        error: null
      }
    }
    const complete: CodexMaintenanceState = {
      ...state(true, '0.136.0'),
      currentJob: null,
      job: { ...running.job!, phase: 'completed', exitCode: 0 }
    }
    call.mockImplementation(async (_target, params) =>
      params.operation === 'status' ? initial : params.operation === 'start' ? running : complete
    )
    render(
      <>
        <Composer />
        <CodexMaintenanceRow target={TARGET} />
      </>
    )
    await flush()
    fireEvent.click(screen.getAllByRole('button', { name: 'Install Codex' })[0])
    await waitFor(
      () => expect(screen.getByText('Command exited with code 0')).toBeInTheDocument(),
      { timeout: 3000 }
    )
    expect(screen.queryByText('Codex not installed')).toBeNull()
    expect(screen.queryByText('Not installed')).toBeNull()
    expect(screen.getByText('Send', { selector: 'button' })).toBeEnabled()
  })
  it('withholds a cached refusal on remount, focus revalidation and failed contact', async () => {
    call.mockResolvedValue(state(true, '0.135.0'))
    const first = render(<Composer />)
    await flush()
    expect(screen.getByText('Codex update required')).toBeInTheDocument()
    first.unmount()
    let rejectRead: (error: Error) => void = () => {}
    call.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject
        })
    )
    render(<Composer />)
    expect(screen.queryByText('Codex update required')).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    await act(async () => {
      rejectRead(new Error('Host unavailable'))
    })
    expect(screen.queryByText('Codex update required')).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    call.mockResolvedValue(state(true, '0.135.0'))
    await flush()
    expect(screen.getByText('Codex update required')).toBeInTheDocument()
    let completeRead: (value: CodexMaintenanceState) => void = () => {}
    call.mockImplementation(
      () =>
        new Promise<CodexMaintenanceState>((resolve) => {
          completeRead = resolve
        })
    )
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(screen.queryByText('Codex update required')).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    await act(async () => {
      completeRead(state(true, '0.136.0'))
    })
    expect(screen.queryByText('Codex update required')).toBeNull()
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
    expect(screen.getByText(/Codex 0.135.0 is too old for chats/)).toBeInTheDocument()
  })
})
