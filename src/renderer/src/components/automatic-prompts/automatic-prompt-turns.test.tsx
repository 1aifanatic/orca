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
import { requestNativeChatResumeOnRestartDialog } from '../native-chat-resume-on-restart-dialog'
import { useOnboardingAndFeatureTips } from '../../app-shell/use-onboarding-and-feature-tips'
import { AUTOMATIC_PROMPT_MODAL_KEY } from '@/store/slices/ui/automatic-prompt-turns'
import { resetLocalStructuredChatsForTests } from '@/runtime/local-structured-chats'
import { AutomaticPromptDialogScope } from '@/lib/dialog-presence'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { CommandDialog } from '../ui/command'
import FeatureTipsModal from '../feature-tips/FeatureTipsModal'
import { FailedFeatureTip, useAppOpenFeatureTip } from '../feature-tips/use-app-open-feature-tip'
import { RecoverableRenderErrorBoundary } from '../error-boundaries/RecoverableRenderErrorBoundary'
import { useAutomaticPromptTurn, usePromptBlockingDialog } from './use-automatic-prompt-turn'

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
const surface = vi.hoisted(() => ({ loaded: Promise.resolve(), suspended: false, mounts: 0 }))
// The real surface is covered by its own tests; here only whether it is on screen matters.
vi.mock('../crash-report/CrashReportDialogSurface', async () => {
  const { useEffect } = await import('react')
  const { DialogPresenceMarker } = await import('@/lib/dialog-presence')
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
        surface.mounts += 1
      }, [])
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
          {/* As the real surface's DialogContent does. */}
          <DialogPresenceMarker />
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
  takePendingReactErrorBoundaryReport: () => boundaryReports.shift() ?? null,
  // What main hands back for a boundary that caught an error.
  reportReactErrorBoundaryCrash: async (args: { boundaryId: string }) => {
    boundaryReports.push({ ...pendingCrash, id: args.boundaryId })
    window.dispatchEvent(new Event('test-boundary-report'))
  }
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

function visibleDialogText(): string {
  return [...document.querySelectorAll('[role="dialog"]')]
    .map((dialog) => dialog.textContent ?? '')
    .join('\n')
}

function resumeDialog(): Element | undefined {
  return [...document.querySelectorAll('[role="dialog"]')].find((dialog) =>
    dialog.textContent?.includes('Resume interrupted chats?')
  )
}

function resumeOnScreen(): boolean {
  return resumeDialog() !== undefined
}

function crashOnScreen(): boolean {
  return document.querySelector('[data-testid="crash-report"]') !== null
}

function sshOnScreen(): boolean {
  return visibleDialogText().includes('SSH Key Passphrase')
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
  surface.mounts = 0
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

it('an SSH credential prompt stacks over a shown resume offer without waiting', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <SshPassphraseDialog />
    </>
  )
  const offer = resumeDialog()
  expect(offer).toBeDefined()

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
  // Left as it was under the SSH prompt: same dialog, same turn, whatever the user had ticked.
  expect(resumeDialog()).toBe(offer)

  await act(async () => useAppStore.getState().removeSshCredentialRequest('r1'))
  await flush()
  expect(sshOnScreen()).toBe(false)
  expect(resumeDialog()).toBe(offer)
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

/** A modal-slot dialog as the app renders it: on screen only while it holds the slot. */
function UserModal(): React.JSX.Element {
  const open = useAppStore((s) => s.activeModal === 'add-repo')
  return (
    <Dialog open={open}>
      <DialogContent>
        <DialogTitle>Add project</DialogTitle>
      </DialogContent>
    </Dialog>
  )
}

it('a modal the user opens stacks over a shown resume offer, which stays as it was', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <UserModal />
    </>
  )
  const offer = resumeDialog()
  expect(offer).toBeDefined()

  await act(async () => useAppStore.getState().openModal('add-repo'))
  expect(visibleDialogText()).toContain('Add project')
  expect(resumeDialog()).toBe(offer)
  await act(async () => useAppStore.getState().closeModal())
  await flush()
  expect(resumeDialog()).toBe(offer)
})

it('a modal-slot dialog that failed to render holds back nothing, not even its own crash report', async () => {
  useAppStore.getState().settleLaunchPromptDiscovery()
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const Thrower = (): null => {
    throw new Error('composer render bug')
  }
  await act(async () => useAppStore.getState().openModal('new-workspace-composer'))
  await mount(
    <>
      <RecoverableRenderErrorBoundary boundaryId="modal.composer" surface="modal" compact resetKey>
        <Thrower />
      </RecoverableRenderErrorBoundary>
      <CrashReportDialog />
    </>
  )
  // The boundary's inline fallback is no dialog, so the report shows while the slot is still set.
  expect(document.body.textContent).toContain('hit an error')
  expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
  expect(shownCrashReportId()).toBe('modal.composer')
  consoleError.mockRestore()
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
  expect(useAppStore.getState().automaticPromptRequests).toEqual([
    expect.objectContaining({ id: 'crash-report', key: 'crash-1', shown: true })
  ])

  await act(async () => window.dispatchEvent(new Event('test-unmount')))
  expect(useAppStore.getState().automaticPromptRequests).toEqual([])
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
      <FeatureTipsModal />
    </>
  )
  expect(useAppStore.getState().automaticPromptRequests.map((r) => r.id)).toContain('feature-tip')
  expect(useAppStore.getState().activeModal).toBe('none')
  expect(useAppStore.getState().featureTipsSeenIds).not.toContain('cmd-j-palette')

  await act(async () => useAppStore.getState().releaseAutomaticPrompt('native-chat-resume'))
  await flush()
  const { activeModal, modalData, featureTipsSeenIds, automaticPromptRequests } =
    useAppStore.getState()
  expect(activeModal).toBe('feature-tips')
  expect(modalData[AUTOMATIC_PROMPT_MODAL_KEY]).toBe('feature-tip')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(featureTipsSeenIds).toContain('cmd-j-palette')
  expect(automaticPromptRequests).toEqual([
    expect.objectContaining({ id: 'feature-tip', shown: true })
  ])

  // Closing the tip ends its turn.
  await act(async () => useAppStore.getState().closeModal())
  await flush()
  expect(useAppStore.getState().automaticPromptRequests).toEqual([])
})

it('a tip replaced by the user before it was ever on screen waits for the slot and opens later', async () => {
  seedOneFeatureTip()
  // Only the owner: the tip's dialog never renders here, as when its lazy chunk is slow.
  await mount(
    <>
      <FeatureTipHarness />
      <UserModal />
    </>
  )
  expect(useAppStore.getState().activeModal).toBe('feature-tips')

  await act(async () => useAppStore.getState().openModal('add-repo'))
  expect(useAppStore.getState().featureTipsSeenIds).not.toContain('cmd-j-palette')
  // It cannot render while the user's modal holds the slot, so it holds no turn meanwhile.
  expect(useAppStore.getState().automaticPromptRequests).toEqual([])

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

  expect(useAppStore.getState().automaticPromptRequests).toEqual([
    expect.objectContaining({ id: 'crash-report', shown: false })
  ])
  expect(crashReports.dismiss).not.toHaveBeenCalled()
})

async function raiseBoundaryReports(...ids: string[]): Promise<void> {
  boundaryReports.push(...ids.map((id) => ({ ...pendingCrash, id })))
  await act(async () => {
    for (const _ of ids) {
      window.dispatchEvent(new Event('test-boundary-report'))
    }
  })
  await flush()
}

it('each crash report takes its own turn; a later one never replaces the one on screen', async () => {
  useAppStore.getState().settleLaunchPromptDiscovery()
  await mount(<CrashReportDialog />)
  await raiseBoundaryReports('boundary-1')
  expect(shownCrashReportId()).toBe('boundary-1')
  await raiseBoundaryReports('boundary-2')
  expect(shownCrashReportId()).toBe('boundary-1')

  await act(async () => screenButton('Close crash report').click())
  await flush()
  expect(shownCrashReportId()).toBe('boundary-2')
  await act(async () => screenButton('Close crash report').click())
  await flush()
  expect(crashOnScreen()).toBe(false)
  expect(useAppStore.getState().automaticPromptRequests).toEqual([])
})

it('one fault tripping several boundaries offers only the newest report, after the launch one', async () => {
  const read = Promise.withResolvers<unknown>()
  rpc.mockImplementation(async () => read.promise)
  crashReports.getLatestPending.mockResolvedValue(pendingCrash)
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <CrashReportDialog />
    </>
  )
  // Still in the launch wait, so none of them has been shown.
  await raiseBoundaryReports('boundary-1', 'boundary-2', 'boundary-3')
  await act(async () => read.resolve({ sessions: [] }))
  await flush()
  expect(shownCrashReportId()).toBe('crash-1')
  await act(async () => screenButton('Close crash report').click())
  await flush()
  expect(shownCrashReportId()).toBe('boundary-3')
  await act(async () => screenButton('Close crash report').click())
  await flush()
  expect(crashOnScreen()).toBe(false)
})

it('the next queued crash report waits for a resume offer that arrived meanwhile, unacknowledged', async () => {
  const read = Promise.withResolvers<unknown>()
  rpc.mockImplementation(async () => read.promise)
  crashReports.getLatestPending.mockResolvedValue({ ...pendingCrash, id: 'crash-launch' })
  boundaryReports.push({ ...pendingCrash, id: 'crash-boundary' })
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <CrashReportDialog />
    </>
  )
  await act(async () => useAppStore.getState().settleLaunchPromptDiscovery())
  await flush()
  expect(shownCrashReportId()).toBe('crash-boundary')
  await act(async () => read.resolve({ sessions: offered }))
  await flush()
  expect(resumeOnScreen()).toBe(false)

  surface.mounts = 0
  await act(async () => screenButton('Close crash report').click())
  await flush()
  // The launch report never rendered, so it was not acknowledged unseen.
  expect(resumeOnScreen()).toBe(true)
  expect(surface.mounts).toBe(0)
  expect(crashReports.dismiss).not.toHaveBeenCalled()

  closeResume()
  await flush()
  expect(shownCrashReportId()).toBe('crash-launch')
  expect(crashReports.dismiss).toHaveBeenCalledWith({ reportId: 'crash-launch' })
})

it('the next queued crash report on screen keeps its turn against a late resume offer', async () => {
  const read = Promise.withResolvers<unknown>()
  rpc.mockImplementation(async () => read.promise)
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <CrashReportDialog />
    </>
  )
  await act(async () => useAppStore.getState().settleLaunchPromptDiscovery())
  await raiseBoundaryReports('boundary-1')
  await raiseBoundaryReports('boundary-2')
  expect(shownCrashReportId()).toBe('boundary-1')

  await act(async () => screenButton('Close crash report').click())
  await flush()
  expect(shownCrashReportId()).toBe('boundary-2')
  expect(useAppStore.getState().automaticPromptRequests).toEqual([
    expect.objectContaining({ id: 'crash-report', key: 'boundary-2', shown: true })
  ])

  await act(async () => read.resolve({ sessions: offered }))
  await flush()
  expect(shownCrashReportId()).toBe('boundary-2')
  expect(resumeOnScreen()).toBe(false)
})

function KeyedOwner({ itemKey }: { itemKey: string }): React.JSX.Element | null {
  const [visible, markShown] = useAutomaticPromptTurn('crash-report', true, itemKey)
  return visible ? <KeyedContent key={itemKey} markShown={markShown} /> : null
}

function KeyedContent({ markShown }: { markShown: () => void }): React.JSX.Element {
  useEffect(() => {
    markShown()
  }, [markShown])
  return <div data-testid="keyed" />
}

it('content that marks itself shown after a key change marks its own item', async () => {
  useAppStore.getState().settleLaunchPromptDiscovery()
  await mount(<KeyedOwner itemKey="a" />)
  await mount(<KeyedOwner itemKey="b" />)
  expect(document.querySelector('[data-testid="keyed"]')).not.toBeNull()
  expect(useAppStore.getState().automaticPromptRequests).toEqual([
    expect.objectContaining({ id: 'crash-report', key: 'b', shown: true })
  ])
})

it('a user-opened command palette holds back a prompt not yet shown', async () => {
  useAppStore.getState().settleLaunchPromptDiscovery()
  const withPalette = (open: boolean): React.ReactNode => (
    <>
      <CommandDialog open={open} title="New Markdown" description="Pick a template">
        <div>picker</div>
      </CommandDialog>
      <CrashReportDialog />
    </>
  )
  await mount(withPalette(true))
  await raiseBoundaryReports('boundary-1')
  expect(crashOnScreen()).toBe(false)
  await mount(withPalette(false))
  expect(shownCrashReportId()).toBe('boundary-1')
})

function PromptWithInnerDialog(): React.JSX.Element | null {
  const [visible, markShown] = useAutomaticPromptTurn('native-chat-resume', true)
  useEffect(() => {
    if (visible) {
      markShown()
    }
  }, [visible, markShown])
  if (!visible) {
    return null
  }
  return (
    <AutomaticPromptDialogScope>
      <Dialog open>
        <DialogContent>
          <DialogTitle>Prompt</DialogTitle>
        </DialogContent>
      </Dialog>
      <InnerResponseDialog />
    </AutomaticPromptDialogScope>
  )
}

/** Like the terminal save-failure dialog under the CLI tip's setup terminal. */
function InnerResponseDialog(): React.JSX.Element {
  usePromptBlockingDialog('inner-response', true)
  return (
    <Dialog open>
      <DialogContent>
        <DialogTitle>Inner</DialogTitle>
      </DialogContent>
    </Dialog>
  )
}

it('a dialog a prompt opens inside itself never holds that prompt back', async () => {
  useAppStore.getState().settleLaunchPromptDiscovery()
  await mount(<PromptWithInnerDialog />)
  expect(visibleDialogText()).toContain('Prompt')
  expect(visibleDialogText()).toContain('Inner')
  expect(useAppStore.getState().automaticPromptRequests).toEqual([
    expect.objectContaining({ id: 'native-chat-resume', shown: true })
  ])
  expect(useAppStore.getState().promptBlockingDialogIds).toEqual([])
  expect(useAppStore.getState().otherDialogOnScreen).toBe(false)
})

it('a dialog opened over a shown resume offer stacks on it; a crash report raised meanwhile waits its turn', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  const withDialog = (open: boolean): React.ReactNode => (
    <>
      <NativeChatResumeOnRestartModal />
      <CrashReportDialog />
      <Dialog open={open}>
        <DialogContent>
          <DialogTitle>Unsaved changes</DialogTitle>
        </DialogContent>
      </Dialog>
    </>
  )
  await mount(withDialog(false))
  const offer = resumeDialog()
  expect(offer).toBeDefined()

  await mount(withDialog(true))
  expect(visibleDialogText()).toContain('Unsaved changes')
  expect(resumeDialog()).toBe(offer)
  await raiseBoundaryReports('boundary-1')
  expect(crashOnScreen()).toBe(false)

  await mount(withDialog(false))
  // Still one automatic prompt at a time: the report waits for the offer, not for the dialog.
  expect(resumeDialog()).toBe(offer)
  expect(crashOnScreen()).toBe(false)
  closeResume()
  await flush()
  expect(shownCrashReportId()).toBe('boundary-1')
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
  await act(async () => useAppStore.getState().openModal('add-repo'))
  await act(async () => window.dispatchEvent(new Event('test-unmount')))
  expect(useAppStore.getState().activeModal).toBe('add-repo')
})

it('the app-level tip owner with no tip pending does not re-render when dialogs open and close', async () => {
  let renders = 0
  function AppLike(): null {
    renders += 1
    useAppOpenFeatureTip()
    return null
  }
  const withDialog = (open: boolean): React.ReactNode => (
    <>
      <AppLike />
      <Dialog open={open}>
        <DialogContent>
          <DialogTitle>Unrelated</DialogTitle>
        </DialogContent>
      </Dialog>
    </>
  )
  await mount(withDialog(false))
  const before = renders
  await mount(withDialog(true))
  await mount(withDialog(false))
  // Only the parent's own renders: the dialog opening and closing adds none.
  expect(renders - before).toBe(2)
})

it('the crash dialog opened from Help shows at once, over a resume offer on screen that stays', async () => {
  let openFromHelp: () => void = () => {}
  Object.assign(window.api.ui, {
    onOpenCrashReport: (callback: () => void) => {
      openFromHelp = callback
      return () => {}
    }
  })
  crashReports.getLatestReport.mockResolvedValue({ ...pendingCrash, status: 'dismissed' })
  rpc.mockResolvedValue({ sessions: offered })
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <CrashReportDialog />
    </>
  )
  const offer = resumeDialog()
  expect(offer).toBeDefined()

  await act(async () => openFromHelp())
  await flush()
  expect(crashOnScreen()).toBe(true)
  expect(resumeDialog()).toBe(offer)
})

it('the resume dialog opened by the user shows at once, over a crash report on screen that stays', async () => {
  // The launch read answers after the wait ended, so the crash report went first.
  const read = Promise.withResolvers<unknown>()
  rpc.mockImplementation(async () => read.promise)
  crashReports.getLatestPending.mockResolvedValue(pendingCrash)
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <CrashReportDialog />
    </>
  )
  await act(async () => useAppStore.getState().settleLaunchPromptDiscovery())
  await flush()
  await act(async () => read.resolve({ sessions: offered }))
  await flush()
  expect(crashOnScreen()).toBe(true)
  expect(resumeOnScreen()).toBe(false)
  const mounts = surface.mounts

  // The user opens the offer from the status bar.
  await act(async () => requestNativeChatResumeOnRestartDialog('user'))
  await flush()
  expect(resumeOnScreen()).toBe(true)
  expect(shownCrashReportId()).toBe('crash-1')
  expect(surface.mounts).toBe(mounts)
})
