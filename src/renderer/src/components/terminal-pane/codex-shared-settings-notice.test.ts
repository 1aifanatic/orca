// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexSharedSettingsNotice } from '../../../../shared/codex-config-sync-types'
import { useCodexSharedSettingsNotice } from './codex-shared-settings-notice'

// Why a real zustand store double: the hook relies on subscribe/setState semantics.
const { toastInfoMock, harness } = vi.hoisted(() => ({
  toastInfoMock: vi.fn(),
  harness: { setState: (_patch: Record<string, unknown>, _replace?: true): void => {} }
}))

vi.mock('sonner', () => ({ toast: { info: toastInfoMock } }))

vi.mock('@/store', async () => {
  const { useStore } = await import('zustand')
  const { createStore } = await import('zustand/vanilla')
  const backing = createStore<Record<string, unknown>>()(() => ({}))
  harness.setState = (patch, replace) =>
    replace ? backing.setState(patch, true) : backing.setState(patch)
  // Why reactive: the hook re-runs when the seen flag changes.
  const useAppStore = <T>(selector: (state: Record<string, unknown>) => T): T =>
    useStore(backing, selector)
  return { useAppStore: Object.assign(useAppStore, backing) }
})

const store = {
  setState: (patch: Record<string, unknown>, replace?: true) => harness.setState(patch, replace)
}
const sharedSettingsNoticeMock = vi.fn<() => Promise<CodexSharedSettingsNotice | null>>()
const codexTab = { 'wt-1': [{ id: 'tab-1', launchAgent: 'codex' }] }
const mountedRoots: Root[] = []
let seen = false

function resetStore(overrides: Record<string, unknown> = {}): void {
  seen = false
  store.setState(
    {
      persistedUIReady: true,
      settings: {},
      codexSharedSettingsNoticeSeen: false,
      tabsByWorktree: {},
      agentStatusByPaneKey: {},
      paneForegroundAgentByPaneKey: {},
      markCodexSharedSettingsNoticeSeen: () => {
        seen = true
        store.setState({ codexSharedSettingsNoticeSeen: true })
      },
      ...overrides
    },
    true
  )
}

function HookProbe(): null {
  useCodexSharedSettingsNotice()
  return null
}

async function mountProbe(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe))
  })
}

describe('useCodexSharedSettingsNotice', () => {
  beforeEach(() => {
    toastInfoMock.mockReset()
    sharedSettingsNoticeMock.mockReset().mockResolvedValue({ mcpServerNames: [] })
    vi.stubGlobal('api', { codexConfigSync: { sharedSettingsNotice: sharedSettingsNoticeMock } })
    resetStore()
  })

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount())
    }
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('shows once a Codex terminal exists, and marks it seen', async () => {
    await mountProbe()
    expect(sharedSettingsNoticeMock).not.toHaveBeenCalled()

    await act(async () => store.setState({ tabsByWorktree: codexTab }))
    await act(async () =>
      store.setState({ agentStatusByPaneKey: { 'tab-1:leaf': { agentType: 'codex' } } })
    )

    expect(sharedSettingsNoticeMock).toHaveBeenCalledTimes(1)
    expect(toastInfoMock).toHaveBeenCalledTimes(1)
    const [title, options] = toastInfoMock.mock.calls[0] ?? []
    expect(title).toBe('Codex in Orca now shares your Codex settings')
    expect(options).toMatchObject({ duration: 15_000 })
    expect(options?.description).not.toContain('MCP')
    expect(seen).toBe(true)
  })

  it('names the MCP servers that need to be added again', async () => {
    sharedSettingsNoticeMock.mockResolvedValue({ mcpServerNames: ['github', 'linear'] })
    resetStore({ tabsByWorktree: codexTab })

    await mountProbe()

    expect(toastInfoMock.mock.calls[0]?.[1]?.description).toContain(
      'MCP servers you added from an Orca terminal (github, linear) need to be added again.'
    )
  })

  it('asks main once and stays unseen when nothing is due', async () => {
    sharedSettingsNoticeMock.mockResolvedValue(null)
    resetStore({ tabsByWorktree: codexTab })
    await mountProbe()

    await act(async () =>
      store.setState({ agentStatusByPaneKey: { 'tab-1:leaf': { agentType: 'codex' } } })
    )

    expect(sharedSettingsNoticeMock).toHaveBeenCalledTimes(1)
    expect(toastInfoMock).not.toHaveBeenCalled()
    expect(seen).toBe(false)
  })

  it('stays quiet once seen', async () => {
    resetStore({ codexSharedSettingsNoticeSeen: true, tabsByWorktree: codexTab })
    await mountProbe()
    expect(sharedSettingsNoticeMock).not.toHaveBeenCalled()
  })

  it('stays quiet in a paired web client window', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    resetStore({ tabsByWorktree: codexTab })
    await mountProbe()
    expect(sharedSettingsNoticeMock).not.toHaveBeenCalled()
  })
})
