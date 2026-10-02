// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCodexSharedSettingsNotice } from './codex-shared-settings-notice'
import { useCodexTerminalServerIsolationNotice } from './codex-terminal-server-isolation-notice'

// Why a real zustand store double: the hooks rely on subscribe/setState semantics.
const { toastInfoMock, visibleToastIds, harness } = vi.hoisted(() => {
  const visible: string[] = []
  return {
    visibleToastIds: visible,
    toastInfoMock: vi.fn((_title: string, options: { id: string; description?: string }) => {
      visible.push(options.id)
    }),
    harness: { setState: (_patch: Record<string, unknown>, _replace?: true): void => {} }
  }
})

vi.mock('sonner', () => ({
  toast: {
    info: toastInfoMock,
    getToasts: () => visibleToastIds.map((id) => ({ id }))
  }
}))

vi.mock('@/store', async () => {
  const { useStore } = await import('zustand')
  const { createStore } = await import('zustand/vanilla')
  const backing = createStore<Record<string, unknown>>()(() => ({}))
  harness.setState = (patch, replace) =>
    replace ? backing.setState(patch, true) : backing.setState(patch)
  // Why reactive: the notice hook re-runs when main's decision lands via a UI sync.
  const useAppStore = <T>(selector: (state: Record<string, unknown>) => T): T =>
    useStore(backing, selector)
  return { useAppStore: Object.assign(useAppStore, backing) }
})

const store = {
  setState: (patch: Record<string, unknown>, replace?: true) => harness.setState(patch, replace)
}
const SHARED_SETTINGS_TOAST_ID = 'codex-shared-settings-notice'
const ISOLATION_TOAST_ID = 'codex-terminal-server-isolation-notice'
const codexTab = { 'wt-1': [{ id: 'tab-1', launchAgent: 'codex' }] }
const mountedRoots: Root[] = []

function resetStore(overrides: Record<string, unknown> = {}): void {
  store.setState(
    {
      persistedUIReady: true,
      codexTerminalServerIsolationNoticeSeen: true,
      settings: { codexTerminalServerIsolation: true },
      codexSharedSettingsNotice: { mcpServerNames: [] },
      tabsByWorktree: {},
      agentStatusByPaneKey: {},
      paneForegroundAgentByPaneKey: {},
      markCodexTerminalServerIsolationNoticeSeen: () =>
        store.setState({ codexTerminalServerIsolationNoticeSeen: true }),
      clearCodexSharedSettingsNotice: () => store.setState({ codexSharedSettingsNotice: null }),
      ...overrides
    },
    true
  )
}

function HookProbe(): null {
  useCodexTerminalServerIsolationNotice()
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

function shownToastIds(): string[] {
  return toastInfoMock.mock.calls.map(([, options]) => options.id)
}

describe('useCodexSharedSettingsNotice', () => {
  beforeEach(() => {
    toastInfoMock.mockClear()
    visibleToastIds.splice(0)
    resetStore()
  })

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount())
    }
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('shows once a Codex terminal exists, and clears the persisted notice', async () => {
    await mountProbe()
    expect(toastInfoMock).not.toHaveBeenCalled()

    act(() => store.setState({ tabsByWorktree: codexTab }))
    act(() => store.setState({ agentStatusByPaneKey: { 'tab-1:leaf': { agentType: 'codex' } } }))

    expect(shownToastIds()).toEqual([SHARED_SETTINGS_TOAST_ID])
    const [title, options] = toastInfoMock.mock.calls[0] ?? []
    expect(title).toBe('Codex in Orca now shares your Codex settings')
    expect(options).toMatchObject({ duration: 15_000 })
    expect(options?.description).not.toContain('MCP')
  })

  it('names the MCP servers that need to be added again', async () => {
    resetStore({
      codexSharedSettingsNotice: { mcpServerNames: ['github', 'linear'] },
      tabsByWorktree: codexTab
    })

    await mountProbe()

    expect(toastInfoMock.mock.calls[0]?.[1]?.description).toContain(
      'MCP servers you added from an Orca terminal (github, linear) need to be added again.'
    )
  })

  it('shows when main records the notice after a Codex terminal is already open', async () => {
    resetStore({ codexSharedSettingsNotice: null, tabsByWorktree: codexTab })
    await mountProbe()
    expect(toastInfoMock).not.toHaveBeenCalled()

    await act(async () => store.setState({ codexSharedSettingsNotice: { mcpServerNames: [] } }))

    expect(shownToastIds()).toEqual([SHARED_SETTINGS_TOAST_ID])
  })

  it('waits for the server-isolation notice instead of stacking on it', async () => {
    resetStore({ codexTerminalServerIsolationNoticeSeen: false })
    await mountProbe()

    act(() => store.setState({ tabsByWorktree: codexTab }))
    act(() => store.setState({ agentStatusByPaneKey: { 'tab-1:leaf': { agentType: 'codex' } } }))
    expect(shownToastIds()).toEqual([ISOLATION_TOAST_ID])

    visibleToastIds.splice(0)
    act(() => store.setState({ agentStatusByPaneKey: { 'tab-1:leaf': { agentType: 'codex' } } }))

    expect(shownToastIds()).toEqual([ISOLATION_TOAST_ID, SHARED_SETTINGS_TOAST_ID])
  })

  it.each([
    ['nothing is due', { codexSharedSettingsNotice: null }],
    ['persisted UI has not hydrated', { persistedUIReady: false }]
  ])('stays quiet when %s', async (_name, overrides) => {
    resetStore({ ...overrides, tabsByWorktree: codexTab })
    await mountProbe()
    expect(toastInfoMock).not.toHaveBeenCalled()
  })

  it('stays quiet in a paired web client window', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    resetStore({ tabsByWorktree: codexTab })
    await mountProbe()
    expect(toastInfoMock).not.toHaveBeenCalled()
  })
})
