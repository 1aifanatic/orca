// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { AUTOMATIC_PROMPT_MODAL_KEY } from '@/store/slices/ui/automatic-prompt-turns'
import FeatureTipsModal from './FeatureTipsModal'
import { SshPassphraseDialog } from '../settings/SshPassphraseDialog'
import { TooltipProvider } from '../ui/tooltip'

const terminal = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))
vi.mock('./CliSkillSetupTerminal', async () => {
  const { useEffect } = await import('react')
  return {
    // Stands in for the inline installer terminal, whose unmount closes its PTY tab.
    CliSkillSetupTerminal: () => {
      useEffect(() => {
        terminal.mounts += 1
        return () => {
          terminal.unmounts += 1
        }
      }, [])
      return <div data-testid="skill-terminal" />
    }
  }
})
vi.mock('./feature-tip-cli-install-action', () => ({
  installCliFromFeatureTip: vi.fn(async () => ({
    kind: 'installed',
    status: { state: 'installed', pathConfigured: true }
  }))
}))
vi.mock('./CliFeatureTipVisual', () => ({ CliFeatureTipVisual: () => null }))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() })
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

beforeEach(() => {
  terminal.mounts = 0
  terminal.unmounts = 0
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ settings: getDefaultSettings(''), persistedUIReady: true })
  useAppStore.getState().settleLaunchPromptDiscovery()
  Object.assign(window, {
    api: {
      cli: { install: vi.fn(async () => ({})) },
      ui: { set: vi.fn(async () => undefined) },
      ssh: { submitCredential: vi.fn(async () => undefined) }
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

it('an SSH prompt arriving mid CLI setup keeps the app-open tip and its setup terminal', async () => {
  // The app-open tip holds its turn and the modal slot, as the owner leaves it.
  act(() => {
    useAppStore.getState().requestAutomaticPrompt('feature-tip')
    useAppStore.getState().openModal('feature-tips', {
      source: 'app_open',
      tipId: 'orca-cli',
      [AUTOMATIC_PROMPT_MODAL_KEY]: 'feature-tip'
    })
  })
  await act(async () =>
    root.render(
      <TooltipProvider>
        <FeatureTipsModal />
        <SshPassphraseDialog />
      </TooltipProvider>
    )
  )
  await flush()
  expect(useAppStore.getState().automaticPromptRequests).toEqual([
    expect.objectContaining({ id: 'feature-tip', shown: true })
  ])
  const install = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Install CLI')
  )
  await act(async () => install?.click())
  await flush()
  expect(terminal).toEqual({ mounts: 1, unmounts: 0 })

  act(() => {
    useAppStore.getState().enqueueSshCredentialRequest({
      requestId: 'r1',
      targetId: 't1',
      kind: 'passphrase',
      detail: '~/.ssh/id_ed25519'
    })
  })
  await flush()
  // Stepped aside under the SSH prompt: hidden, but the installer keeps running.
  const tipDialog = document
    .querySelector('[data-testid="skill-terminal"]')
    ?.closest('[role="dialog"]')
  expect(tipDialog?.hasAttribute('data-stepped-aside')).toBe(true)
  expect(terminal).toEqual({ mounts: 1, unmounts: 0 })

  await act(async () => useAppStore.getState().removeSshCredentialRequest('r1'))
  await flush()
  expect(tipDialog?.hasAttribute('data-stepped-aside')).toBe(false)
  expect(terminal).toEqual({ mounts: 1, unmounts: 0 })
})
