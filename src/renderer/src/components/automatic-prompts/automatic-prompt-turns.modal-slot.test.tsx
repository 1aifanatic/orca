// @vitest-environment happy-dom

import { act, lazy, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import { useOnboardingAndFeatureTips } from '../../app-shell/use-onboarding-and-feature-tips'
import { MODAL_DISMISSED_KEY } from '@/store/slices/modal-slot-dismissal'
import { DialogLoadingSuspense } from '@/lib/dialog-presence'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { TooltipProvider } from '../ui/tooltip'
import FeatureTipsModal from '../feature-tips/FeatureTipsModal'
import { RecoverableRenderErrorBoundary } from '../error-boundaries/RecoverableRenderErrorBoundary'
import { useAutomaticPromptTurn } from './use-automatic-prompt-turn'

vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/lib/react-error-boundary-reporting', () => ({
  reportReactErrorBoundaryCrash: async () => undefined
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement

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

function FeatureTipHarness(): null {
  const { applyStartupOnboardingState } = useOnboardingAndFeatureTips()
  useEffect(() => {
    applyStartupOnboardingState({ ...getDefaultOnboardingState(), closedAt: 1 })
  }, [applyStartupOnboardingState])
  return null
}

/** Leaves one tip to show, the keyboard palette one, queued while the launch wait is still on. */
function seedOneFeatureTip(): void {
  useAppStore.setState({
    persistedUIReady: true,
    featureTipsSeenIds: ['voice-dictation', 'agent-session-search']
  })
}

/** A resume-offer-like prompt: rendered while it holds its turn, marked shown once on screen. */
function StandInPrompt(): React.JSX.Element | null {
  const [visible, markShown] = useAutomaticPromptTurn('native-chat-resume', true)
  useEffect(() => {
    if (visible) {
      markShown()
    }
  }, [visible, markShown])
  return visible ? <div data-testid="prompt" /> : null
}

function promptOnScreen(): boolean {
  return document.querySelector('[data-testid="prompt"]') !== null
}

/** A user's modal whose code loads on first use, as the app's lazy slot modals do. */
function lazyUserModal(load: Promise<void>): React.ComponentType {
  return lazy(async () => {
    await load
    return {
      default: function UserModal(): React.JSX.Element {
        const open = useAppStore((s) => s.activeModal === 'worktree-palette')
        return (
          <Dialog open={open}>
            <DialogContent>
              <DialogTitle>Jump to worktree</DialogTitle>
            </DialogContent>
          </Dialog>
        )
      }
    }
  })
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: getDefaultSettings(''),
    launchPromptDiscoveryDeadline: Date.now() + 60_000
  })
  Object.assign(window, {
    api: {
      ui: { set: vi.fn(async () => undefined) },
      cli: { getInstallStatus: vi.fn(async () => ({ supported: false })) }
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
})

it('the tip never replaces a modal the user opened, even one still loading', async () => {
  seedOneFeatureTip()
  await mount(
    <>
      <FeatureTipHarness />
      <FeatureTipsModal />
    </>
  )
  expect(useAppStore.getState().automaticPromptRequests.map((r) => r.id)).toEqual(['feature-tip'])

  // The palette's code is still loading, so nothing of it is on screen yet.
  await act(async () => useAppStore.getState().openModal('worktree-palette'))
  await act(async () => useAppStore.getState().settleLaunchPromptDiscovery())
  await flush()
  expect(useAppStore.getState().activeModal).toBe('worktree-palette')
  expect(useAppStore.getState().automaticPromptRequests).toEqual([])
  expect(useAppStore.getState().featureTipsSeenIds).not.toContain('cmd-j-palette')

  // Once the user is done with it, the tip takes its turn.
  await act(async () => useAppStore.getState().closeModal())
  await flush()
  expect(useAppStore.getState().activeModal).toBe('feature-tips')
  expect(useAppStore.getState().featureTipsSeenIds).toContain('cmd-j-palette')
})

it('the tip never answers the hooks trust prompt for the user', async () => {
  seedOneFeatureTip()
  await mount(
    <>
      <FeatureTipHarness />
      <FeatureTipsModal />
    </>
  )
  const settle = vi.fn()
  await act(async () =>
    useAppStore
      .getState()
      .openModal('confirm-orca-yaml-hooks', { [MODAL_DISMISSED_KEY]: () => settle('skip') })
  )
  await act(async () => useAppStore.getState().settleLaunchPromptDiscovery())
  await flush()
  expect(settle).not.toHaveBeenCalled()
  expect(useAppStore.getState().activeModal).toBe('confirm-orca-yaml-hooks')
})

it('a tip replaced before it was ever on screen asks again once the slot is free, whatever held it', async () => {
  seedOneFeatureTip()
  useAppStore.getState().settleLaunchPromptDiscovery()
  // Only the owner: the tip's dialog has not rendered, as while its own code loads.
  await mount(<FeatureTipHarness />)
  expect(useAppStore.getState().activeModal).toBe('feature-tips')

  // Something takes the slot and gives it back without rendering a dialog.
  await act(async () => useAppStore.getState().openModal('project-added'))
  expect(useAppStore.getState().automaticPromptRequests).toEqual([])
  await act(async () => useAppStore.getState().closeModal())
  await flush()
  expect(useAppStore.getState().activeModal).toBe('feature-tips')
})

it('a prompt not yet shown waits while a modal the user opened is still loading', async () => {
  useAppStore.getState().settleLaunchPromptDiscovery()
  const chunk = Promise.withResolvers<void>()
  const UserModal = lazyUserModal(chunk.promise)
  await act(async () => useAppStore.getState().openModal('worktree-palette'))
  await mount(
    <>
      <DialogLoadingSuspense>
        <UserModal />
      </DialogLoadingSuspense>
      <StandInPrompt />
    </>
  )
  expect(promptOnScreen()).toBe(false)

  await act(async () => chunk.resolve())
  await flush()
  expect(document.body.textContent).toContain('Jump to worktree')
  expect(promptOnScreen()).toBe(false)

  await act(async () => useAppStore.getState().closeModal())
  await flush()
  expect(promptOnScreen()).toBe(true)
})

it('a modal that failed to load holds nothing back', async () => {
  useAppStore.getState().settleLaunchPromptDiscovery()
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const chunk = Promise.withResolvers<void>()
  const UserModal = lazyUserModal(chunk.promise)
  await act(async () => useAppStore.getState().openModal('worktree-palette'))
  await mount(
    <>
      <DialogLoadingSuspense>
        <RecoverableRenderErrorBoundary boundaryId="modal.palette" surface="modal" compact resetKey>
          <UserModal />
        </RecoverableRenderErrorBoundary>
      </DialogLoadingSuspense>
      <StandInPrompt />
    </>
  )
  expect(promptOnScreen()).toBe(false)

  await act(async () => chunk.reject(new Error('chunk failed')))
  await flush()
  expect(document.body.textContent).toContain('hit an error')
  expect(promptOnScreen()).toBe(true)
  consoleError.mockRestore()
})
