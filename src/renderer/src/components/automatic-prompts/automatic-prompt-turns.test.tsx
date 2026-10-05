// @vitest-environment happy-dom

import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import type { CrashReportRecord } from '../../../../shared/crash-reporting'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import { NativeChatResumeOnRestartModal } from '../NativeChatResumeOnRestartModal'
import { CrashReportDialog } from '../crash-report/CrashReportDialog'
import { SshPassphraseDialog } from '../settings/SshPassphraseDialog'
import { TooltipProvider } from '../ui/tooltip'
import type { ResumeCandidate } from '../native-chat-resume-on-restart-grouping'
import { _resetNativeChatRestartOffer } from '../native-chat-resume-on-restart-store'
import { useOnboardingAndFeatureTips } from '../../app-shell/use-onboarding-and-feature-tips'
import { AUTOMATIC_PROMPT_MODAL_KEY } from '@/store/slices/ui/automatic-prompt-turns'
import { resetLocalStructuredChatsForTests } from '@/runtime/local-structured-chats'
import { AutomaticPromptDialogScope } from '@/lib/dialog-presence'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import FeatureTipsModal from '../feature-tips/FeatureTipsModal'
import { FailedFeatureTip } from '../feature-tips/use-app-open-feature-tip'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  subscribeStructuredAgentSessionStatus: () => new Promise(() => {})
}))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: vi.fn(async () => true)
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
const surface = vi.hoisted(() => ({ loaded: Promise.resolve(), suspended: false }))
// The real surface is covered by its own tests; here only whether it is on screen matters.
vi.mock('../crash-report/CrashReportDialogSurface', async () => {
  const { useEffect } = await import('react')
  return {
    CrashReportDialogSurface: ({
      open,
      report,
      onOpenChange,
      onShown
    }: {
      open: boolean
      report: CrashReportRecord | null
      onOpenChange: (open: boolean) => void
      onShown?: () => void
    }) => {
      useEffect(() => {
        if (open) {
          onShown?.()
        }
      }, [open, onShown])
      if (surface.suspended) {
        // A lazy chunk still loading: granted the turn, nothing on screen yet.
        throw surface.loaded
      }
      return (
        <div role="dialog" data-testid="crash-report" data-report={report?.id}>
          {report?.status}
          <button type="button" onClick={() => onOpenChange(false)}>
            Close crash report
          </button>
        </div>
      )
    }
  }
})
const boundaryReports = vi.hoisted((): CrashReportRecord[] => [])
vi.mock('@/lib/react-error-boundary-reporting', () => ({
  REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT: 'test-boundary-report',
  takePendingReactErrorBoundaryReport: () => boundaryReports.shift() ?? null
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement

const offered: ResumeCandidate[] = [
  {
    sessionId: 'a',
    workspaceId: 'workspace',
    agent: 'codex',
    trigger: 'update',
    latestPrompt: 'Prompt a',
    recordedAt: 1_800_000_000_000,
    executionHostId: 'local',
    workspaceKind: 'git-worktree'
  }
]

const pendingCrash: CrashReportRecord = {
  id: 'crash-1',
  createdAt: '2026-10-05T00:00:00.000Z',
  status: 'pending',
  source: 'renderer',
  processType: 'renderer',
  reason: 'crashed',
  exitCode: 5,
  appVersion: '1.0.0',
  platform: 'darwin',
  osRelease: 'test',
  arch: 'arm64',
  electronVersion: '1',
  chromeVersion: '1',
  details: {}
}

const crashReports = {
  getLatestPending: vi.fn(async (): Promise<CrashReportRecord | null> => null),
  getLatestReport: vi.fn(async (): Promise<CrashReportRecord | null> => null),
  dismiss: vi.fn(async () => undefined)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function mount(node: React.ReactNode): Promise<void> {
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
  await flush()
}

function resumeOnScreen(): boolean {
  return document.body.textContent?.includes('Resume interrupted chats?') === true
}

function crashOnScreen(): boolean {
  return document.querySelector('[data-testid="crash-report"]') !== null
}

function sshOnScreen(): boolean {
  return document.body.textContent?.includes('SSH Key Passphrase') === true
}

function screenButton(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label
  )
  if (!found) {
    throw new Error(`Missing button: ${label}`)
  }
  return found
}

function shownCrashReportId(): string | null {
  return document.querySelector('[data-testid="crash-report"]')?.getAttribute('data-report') ?? null
}

function closeResume(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

beforeEach(() => {
  rpc.mockReset()
  crashReports.getLatestPending.mockReset().mockResolvedValue(null)
  crashReports.getLatestReport.mockReset().mockResolvedValue(null)
  crashReports.dismiss.mockReset().mockResolvedValue(undefined)
  _resetNativeChatRestartOffer()
  resetLocalStructuredChatsForTests()
  surface.suspended = false
  boundaryReports.length = 0
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...getDefaultSettings(''), experimentalStructuredNativeChat: true },
    // Far enough out that only the resume read can end the launch wait in these cases.
    launchPromptDiscoveryDeadline: Date.now() + 60_000
  })
  Object.assign(window, {
    api: {
      crashReports,
      ui: { onOpenCrashReport: () => () => {}, set: vi.fn(async () => undefined) },
      ssh: { submitCredential: vi.fn(async () => undefined) },
      cli: { getInstallStatus: vi.fn(async () => ({ supported: false })) },
      gh: { viewer: vi.fn(async () => null) },
      app: {
        holdsStructuredAgentSessions: vi.fn(async () => false),
        onStructuredAgentSessionsHeldChanged: () => () => {}
      }
    }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAppStore.getState().settleLaunchPromptDiscovery()
  useAppStore.setState(useAppStore.getInitialState(), true)
  _resetNativeChatRestartOffer()
})

it('a fast crash report waits for a slow local resume read, which goes first', async () => {
  const read = Promise.withResolvers<unknown>()
  rpc.mockImplementation(async () => read.promise)
  crashReports.getLatestPending.mockResolvedValue(pendingCrash)

  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <CrashReportDialog />
    </>
  )
  expect(crashOnScreen()).toBe(false)
  // Acknowledged only when shown.
  expect(crashReports.dismiss).not.toHaveBeenCalled()

  await act(async () => read.resolve({ sessions: offered }))
  await flush()
  expect(resumeOnScreen()).toBe(true)
  expect(crashOnScreen()).toBe(false)

  closeResume()
  await flush()
  expect(resumeOnScreen()).toBe(false)
  expect(crashOnScreen()).toBe(true)
  expect(crashReports.dismiss).toHaveBeenCalledWith({ reportId: 'crash-1' })
})

it('shows the crash report at once when the resume read finds nothing', async () => {
  rpc.mockResolvedValue({ sessions: [] })
  crashReports.getLatestPending.mockResolvedValue(pendingCrash)

  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <CrashReportDialog />
    </>
  )
  expect(resumeOnScreen()).toBe(false)
  expect(crashOnScreen()).toBe(true)
})

it('a failed acknowledgment does not hold the crash report back', async () => {
  useAppStore.getState().settleLaunchPromptDiscovery()
  crashReports.getLatestPending.mockResolvedValue(pendingCrash)
  crashReports.dismiss.mockRejectedValue(new Error('disk full'))
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

  await mount(<CrashReportDialog />)
  expect(crashOnScreen()).toBe(true)
  // Still pending, so the dialog dismisses it on close instead.
  expect(document.querySelector('[data-testid="crash-report"]')?.textContent).toContain('pending')
  consoleError.mockRestore()
})

it('an SSH credential prompt shows over a visible resume offer without waiting', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <SshPassphraseDialog />
    </>
  )
  expect(resumeOnScreen()).toBe(true)

  await act(async () =>
    useAppStore.getState().enqueueSshCredentialRequest({
      requestId: 'r1',
      targetId: 'host',
      kind: 'passphrase',
      detail: '~/.ssh/id_ed25519'
    })
  )
  await flush()
  expect(sshOnScreen()).toBe(true)
  expect(resumeOnScreen()).toBe(false)

  await act(async () => useAppStore.getState().removeSshCredentialRequest('r1'))
  await flush()
  expect(sshOnScreen()).toBe(false)
  expect(resumeOnScreen()).toBe(true)
})

it('an SSH credential prompt never waits for the launch read', async () => {
  rpc.mockImplementation(() => new Promise(() => {}))
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <SshPassphraseDialog />
    </>
  )
  expect(useAppStore.getState().launchPromptDiscoveryPending).toBe(true)
  await act(async () =>
    useAppStore.getState().enqueueSshCredentialRequest({
      requestId: 'r1',
      targetId: 'host',
      kind: 'password',
      detail: 'me@host'
    })
  )
  await flush()
  expect(document.body.textContent).toContain('SSH Password')
})

it('a modal the user opens hides the resume offer, which comes back after', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  expect(resumeOnScreen()).toBe(true)

  await act(async () => useAppStore.getState().openModal('settings'))
  expect(resumeOnScreen()).toBe(false)
  await act(async () => useAppStore.getState().closeModal())
  expect(resumeOnScreen()).toBe(true)
})

function Toggle({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const [shown, setShown] = useState(true)
  useEffect(() => {
    const hide = (): void => setShown(false)
    window.addEventListener('test-unmount', hide)
    return () => window.removeEventListener('test-unmount', hide)
  }, [])
  return shown ? <>{children}</> : null
}

it('an owner that unmounts mid-turn releases it', async () => {
  useAppStore.getState().settleLaunchPromptDiscovery()
  crashReports.getLatestPending.mockResolvedValue(pendingCrash)
  await mount(
    <Toggle>
      <CrashReportDialog />
    </Toggle>
  )
  expect(useAppStore.getState().automaticPromptShownId).toBe('crash-report')

  await act(async () => window.dispatchEvent(new Event('test-unmount')))
  expect(useAppStore.getState().automaticPromptRequests).toEqual([])
  expect(useAppStore.getState().automaticPromptShownId).toBeNull()
})

function FeatureTipHarness(): null {
  const { applyStartupOnboardingState } = useOnboardingAndFeatureTips()
  useEffect(() => {
    applyStartupOnboardingState({ ...getDefaultOnboardingState(), closedAt: 1 })
  }, [applyStartupOnboardingState])
  return null
}

/** Leaves one tip to show, the keyboard palette one, whose dialog needs nothing else. */
function seedOneFeatureTip(): void {
  useAppStore.setState({
    persistedUIReady: true,
    featureTipsSeenIds: ['voice-dictation', 'agent-session-search']
  })
  useAppStore.getState().settleLaunchPromptDiscovery()
}

it('marks a feature tip seen only once its dialog is on screen', async () => {
  seedOneFeatureTip()
  // The resume offer holds the turn.
  useAppStore.getState().requestAutomaticPrompt('native-chat-resume')
  useAppStore.getState().markAutomaticPromptShown('native-chat-resume')

  await mount(
    <>
      <FeatureTipHarness />
      <AutomaticPromptDialogScope.Provider value>
        <FeatureTipsModal />
      </AutomaticPromptDialogScope.Provider>
    </>
  )
  expect(useAppStore.getState().automaticPromptRequests.map((r) => r.id)).toContain('feature-tip')
  expect(useAppStore.getState().activeModal).toBe('none')
  expect(useAppStore.getState().featureTipsSeenIds).not.toContain('cmd-j-palette')

  await act(async () => useAppStore.getState().releaseAutomaticPrompt('native-chat-resume'))
  await flush()
  const { activeModal, modalData, featureTipsSeenIds, automaticPromptShownId } =
    useAppStore.getState()
  expect(activeModal).toBe('feature-tips')
  expect(modalData[AUTOMATIC_PROMPT_MODAL_KEY]).toBe('feature-tip')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(featureTipsSeenIds).toContain('cmd-j-palette')
  expect(automaticPromptShownId).toBe('feature-tip')

  // Closing the tip ends its turn.
  await act(async () => useAppStore.getState().closeModal())
  await flush()
  expect(useAppStore.getState().automaticPromptRequests).toEqual([])
})

it('a tip replaced by the user before it was ever on screen keeps its turn and opens later', async () => {
  seedOneFeatureTip()
  // Only the owner: the tip's dialog never renders here, as when its lazy chunk is slow.
  await mount(<FeatureTipHarness />)
  expect(useAppStore.getState().activeModal).toBe('feature-tips')

  await act(async () => useAppStore.getState().openModal('settings'))
  expect(useAppStore.getState().featureTipsSeenIds).not.toContain('cmd-j-palette')
  expect(useAppStore.getState().automaticPromptRequests.map((r) => r.id)).toEqual(['feature-tip'])

  await act(async () => useAppStore.getState().closeModal())
  await flush()
  expect(useAppStore.getState().activeModal).toBe('feature-tips')
})

it('a tip whose dialog fails to render gives up its turn', async () => {
  seedOneFeatureTip()
  await mount(<FeatureTipHarness />)
  expect(useAppStore.getState().activeModal).toBe('feature-tips')

  await mount(
    <>
      <FeatureTipHarness />
      <FailedFeatureTip />
    </>
  )
  expect(useAppStore.getState().activeModal).toBe('none')
  expect(useAppStore.getState().automaticPromptRequests).toEqual([])
})

it('a resume offer read after the wait ended is shown after what went first, not skipped', async () => {
  const read = Promise.withResolvers<unknown>()
  rpc.mockImplementation(async () => read.promise)
  crashReports.getLatestPending.mockResolvedValue(pendingCrash)
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <CrashReportDialog />
    </>
  )
  expect(crashOnScreen()).toBe(false)

  // The bound from the read's start runs out before the read answers.
  await act(async () => useAppStore.getState().settleLaunchPromptDiscovery())
  await flush()
  expect(crashOnScreen()).toBe(true)

  await act(async () => read.resolve({ sessions: offered }))
  await flush()
  expect(resumeOnScreen()).toBe(false)
  expect(crashOnScreen()).toBe(true)

  await act(async () => screenButton('Close crash report').click())
  await flush()
  expect(crashOnScreen()).toBe(false)
  expect(resumeOnScreen()).toBe(true)
})

it('a crash report whose dialog has not rendered yet is neither acknowledged nor holding its turn', async () => {
  useAppStore.getState().settleLaunchPromptDiscovery()
  surface.suspended = true
  surface.loaded = new Promise<void>(() => {})
  crashReports.getLatestPending.mockResolvedValue(pendingCrash)
  await mount(<CrashReportDialog />)

  expect(useAppStore.getState().automaticPromptRequests.map((r) => r.id)).toEqual(['crash-report'])
  expect(useAppStore.getState().automaticPromptShownId).toBeNull()
  expect(crashReports.dismiss).not.toHaveBeenCalled()
})

it('each crash report takes its own turn; a second never replaces the first', async () => {
  useAppStore.getState().settleLaunchPromptDiscovery()
  await mount(<CrashReportDialog />)
  boundaryReports.push({ ...pendingCrash, id: 'boundary-1' }, { ...pendingCrash, id: 'boundary-2' })
  await act(async () => {
    window.dispatchEvent(new Event('test-boundary-report'))
    window.dispatchEvent(new Event('test-boundary-report'))
  })
  await flush()
  expect(shownCrashReportId()).toBe('boundary-1')

  await act(async () => screenButton('Close crash report').click())
  await flush()
  expect(shownCrashReportId()).toBe('boundary-2')
  await act(async () => screenButton('Close crash report').click())
  await flush()
  expect(crashOnScreen()).toBe(false)
  expect(useAppStore.getState().automaticPromptRequests).toEqual([])
})

it('any other dialog on screen holds a visible resume offer back until it closes', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  expect(resumeOnScreen()).toBe(true)

  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <Dialog open>
        <DialogContent>
          <DialogTitle>Unsaved changes</DialogTitle>
        </DialogContent>
      </Dialog>
    </>
  )
  expect(resumeOnScreen()).toBe(false)

  await mount(<NativeChatResumeOnRestartModal />)
  expect(resumeOnScreen()).toBe(true)
})

it('a machine with no chats ends the launch wait by itself', async () => {
  useAppStore.setState({
    settings: { ...getDefaultSettings(''), experimentalStructuredNativeChat: false }
  })
  await mount(<NativeChatResumeOnRestartModal />)
  expect(rpc).not.toHaveBeenCalled()
  expect(useAppStore.getState().launchPromptDiscoveryPending).toBe(false)
})

it('the tip owner going away closes its own tip, never a modal the user opened instead', async () => {
  seedOneFeatureTip()
  await mount(
    <Toggle>
      <FeatureTipHarness />
    </Toggle>
  )
  expect(useAppStore.getState().activeModal).toBe('feature-tips')
  await act(async () => window.dispatchEvent(new Event('test-unmount')))
  expect(useAppStore.getState().activeModal).toBe('none')
  expect(useAppStore.getState().automaticPromptRequests).toEqual([])

  act(() => root.unmount())
  root = createRoot(container)
  useAppStore.setState({ featureTipsSeenIds: ['voice-dictation', 'agent-session-search'] })
  await mount(
    <Toggle>
      <FeatureTipHarness />
    </Toggle>
  )
  await act(async () => useAppStore.getState().openModal('settings'))
  await act(async () => window.dispatchEvent(new Event('test-unmount')))
  expect(useAppStore.getState().activeModal).toBe('settings')
})
