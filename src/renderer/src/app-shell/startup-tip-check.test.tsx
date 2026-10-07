// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resetDialogRegistryForTests, useDialogRegistry } from '@/store/dialog-registry'
import { getDefaultSettings } from '../../../shared/constants'
import type { OnboardingState } from '../../../shared/onboarding-state-types'
import { getDefaultOnboardingState } from '../../../shared/onboarding-defaults'
import { useAppStartupHydration } from './use-app-startup-hydration'
import { useOnboardingAndFeatureTips, type OnboardingGate } from './use-onboarding-and-feature-tips'

const startup = vi.hoisted(() => {
  const fetchSettings = vi.fn(async () => {})
  return {
    fetchSettings,
    recover: vi.fn(async () => {}),
    // Stable, as the real selector's: a new identity would restart the chain.
    actions: {
      fetchOrcaProfiles: vi.fn(async () => {}),
      fetchSettings,
      fetchKeybindings: vi.fn(async () => {}),
      hydratePersistedUI: vi.fn(),
      initGitHubCache: vi.fn(async () => {})
    }
  }
})
vi.mock('./use-app-startup-actions', () => ({ useStartupActions: () => startup.actions }))
vi.mock('../startup/startup-degraded-recovery', () => ({
  recoverFromDegradedStartup: startup.recover
}))
vi.mock('../runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: vi.fn(async () => {})
}))
vi.mock('@/components/terminal-pane/codex-detached-pane-restart-scheduler', () => ({
  installCodexDetachedPaneRestartExecutor: () => () => {}
}))
vi.mock('../components/terminal-pane/terminal-appearance', () => ({
  publishTerminalViewAttributesAtAppStart: vi.fn()
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement

const existingUser: OnboardingState = {
  ...getDefaultOnboardingState(),
  closedAt: 1,
  outcome: 'completed'
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Startup as App wires it: the gate, then the chain feeding it. */
function App({ onGate }: { onGate: (gate: OnboardingGate) => void }): null {
  const gate = useOnboardingAndFeatureTips()
  onGate(gate)
  useAppStartupHydration(gate.applyStartupOnboardingState, gate.applyStartupTipCheckInputs)
  return null
}

let gate: OnboardingGate | null = null
const onboardingRead = { get: vi.fn(async (): Promise<OnboardingState> => existingUser) }

beforeEach(() => {
  gate = null
  resetDialogRegistryForTests()
  startup.fetchSettings.mockReset().mockImplementation(async () => {
    useAppStore.setState({ settings: getDefaultSettings('') })
  })
  startup.recover.mockReset().mockResolvedValue(undefined)
  onboardingRead.get.mockReset().mockResolvedValue(existingUser)
  useAppStore.setState(useAppStore.getInitialState(), true)
  Object.assign(window, {
    api: {
      onboarding: onboardingRead,
      // Startup stops here: everything after this read is out of scope.
      ui: { get: () => new Promise(() => {}), set: vi.fn(async () => undefined) },
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
})

async function start(): Promise<void> {
  await act(async () => root.render(<App onGate={(next) => (gate = next)} />))
  await flush()
}

function tipCheck(): string {
  return useDialogRegistry.getState().startupSources['feature-tip']
}

it('a failed settings read answers the tip check unavailable, so later dialogs do not wait', async () => {
  // The real fetch swallows the failure and leaves settings unset.
  startup.fetchSettings.mockResolvedValue(undefined)
  await start()
  expect(tipCheck()).toBe('unavailable')
})

it('a failed onboarding read answers the tip check unavailable', async () => {
  onboardingRead.get.mockRejectedValue(new Error('ipc down'))
  await start()
  expect(tipCheck()).toBe('unavailable')
})

it('startup failing before onboarding is read answers the tip check unavailable', async () => {
  startup.fetchSettings.mockRejectedValue(new Error('boom'))
  await start()
  expect(startup.recover).toHaveBeenCalledTimes(1)
  expect(onboardingRead.get).not.toHaveBeenCalled()
  expect(tipCheck()).toBe('unavailable')
})

it('the tip check has onboarding as soon as it is read, before startup shows onboarding', async () => {
  await start()
  // Startup has not delivered onboarding to the flow yet (it is parked at ui.get) ...
  expect(gate?.onboarding).toBeNull()
  // ... and the tip check waits only for its own remaining inputs.
  expect(tipCheck()).toBe('pending')
  act(() => useAppStore.setState({ persistedUIReady: true }))
  await flush()
  // Every tip is open for this profile, so it decides one and its host answers once queued.
  expect(gate?.appOpenTipId).not.toBeNull()
})

it('with every tip already seen it answers none without waiting for the CLI status', async () => {
  const cliStatus = Promise.withResolvers<never>()
  Object.assign(window.api.cli, { getInstallStatus: () => cliStatus.promise })
  await start()
  act(() =>
    useAppStore.setState({
      persistedUIReady: true,
      featureTipsSeenIds: ['agent-session-search', 'orca-cli', 'cmd-j-palette', 'voice-dictation']
    })
  )
  await flush()
  expect(tipCheck()).toBe('none')
})
