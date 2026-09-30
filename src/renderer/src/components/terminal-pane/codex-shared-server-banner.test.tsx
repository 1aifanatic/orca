// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  CODEX_DISABLE_AUTO_START_COMMAND,
  CodexSharedServerBanner
} from './CodexSharedServerBanner'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PANE_KEY = 'tab-1:leaf-1'
let paneElement: HTMLDivElement
let root: Root
let isCodexOnSharedServer: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>
let writeClipboardText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>
let updateSettings: ReturnType<typeof vi.fn<(updates: Partial<GlobalSettings>) => Promise<void>>>
let nextPtyId = 0
let ptyId: string

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

function setState(settings: Partial<GlobalSettings>, agent: 'codex' | null = 'codex'): void {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/me'), ...settings },
    paneForegroundAgentByPaneKey: agent ? { [PANE_KEY]: { agent, shellForeground: false } } : {},
    updateSettings
  })
}

async function renderBanner(): Promise<void> {
  await act(async () => {
    root.render(<CodexSharedServerBanner ptyId={ptyId} paneKey={PANE_KEY} />)
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(paneElement.querySelectorAll('button')).find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label
  )
  if (!match) {
    throw new Error(`missing ${label} button`)
  }
  return match
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  useAppStore.setState(useAppStore.getInitialState(), true)
  ptyId = `pty-${(nextPtyId += 1)}`
  paneElement = document.createElement('div')
  paneElement.className = 'pane'
  document.body.appendChild(paneElement)
  root = createRoot(paneElement)
  isCodexOnSharedServer = vi.fn(() => Promise.resolve(true))
  writeClipboardText = vi.fn(() => Promise.resolve())
  updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
    setState({ ...useAppStore.getState().settings, ...updates })
    return Promise.resolve()
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { pty: { isCodexOnSharedServer }, ui: { writeClipboardText } }
  })
})

afterEach(() => {
  act(() => root.unmount())
  paneElement.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('CodexSharedServerBanner', () => {
  it('shows the command and reserves its height at the top of the pane', async () => {
    setState({})
    await renderBanner()
    expect(paneElement.textContent).not.toContain(CODEX_DISABLE_AUTO_START_COMMAND)

    await advance(1_000)

    expect(isCodexOnSharedServer).toHaveBeenCalledWith(ptyId)
    expect(paneElement.textContent).toContain('agent status may be wrong')
    expect(paneElement.textContent).toContain(CODEX_DISABLE_AUTO_START_COMMAND)
    expect(paneElement.dataset.topBanner).toBe('')
    expect(paneElement.style.getPropertyValue('--orca-pane-top-banner-height')).toMatch(/px$/)
  })

  it('keeps asking while Codex starts, then stops once it has an answer', async () => {
    setState({})
    isCodexOnSharedServer.mockResolvedValueOnce(false)
    await renderBanner()
    await advance(1_000)
    expect(paneElement.textContent).toBe('')
    await advance(4_000)
    expect(paneElement.textContent).toContain(CODEX_DISABLE_AUTO_START_COMMAND)
    await advance(60_000)
    expect(isCodexOnSharedServer).toHaveBeenCalledTimes(2)
  })

  it('copies the command', async () => {
    setState({})
    await renderBanner()
    await advance(1_000)
    await act(async () => button('Copy').click())
    expect(writeClipboardText).toHaveBeenCalledWith(CODEX_DISABLE_AUTO_START_COMMAND)
    expect(paneElement.textContent).toContain('Copied')
  })

  it('dismisses for this pane only, and stays dismissed after a remount', async () => {
    setState({})
    await renderBanner()
    await advance(1_000)
    await act(async () => button('Dismiss').click())
    expect(paneElement.textContent).toBe('')
    expect(paneElement.dataset.topBanner).toBeUndefined()
    expect(updateSettings).not.toHaveBeenCalled()

    act(() => root.unmount())
    root = createRoot(paneElement)
    await renderBanner()
    await advance(20_000)
    expect(paneElement.textContent).toBe('')
  })

  it("persists Don't show again as a setting", async () => {
    setState({})
    await renderBanner()
    await advance(1_000)
    await act(async () => button("Don't show again").click())
    expect(updateSettings).toHaveBeenCalledWith({ codexSharedServerWarning: false })
    expect(paneElement.textContent).toBe('')
  })

  it.each([
    ['isolation is off', { codexTerminalServerIsolation: false }],
    ["Don't show again was chosen", { codexSharedServerWarning: false }]
  ])('never asks or shows when %s', async (_label, settings) => {
    setState(settings)
    await renderBanner()
    await advance(20_000)
    expect(isCodexOnSharedServer).not.toHaveBeenCalled()
    expect(paneElement.textContent).toBe('')
  })

  it('hides when Codex leaves the pane', async () => {
    setState({})
    await renderBanner()
    await advance(1_000)
    expect(paneElement.textContent).toContain(CODEX_DISABLE_AUTO_START_COMMAND)
    await act(async () => setState({}, null))
    expect(paneElement.textContent).toBe('')
  })
})
