import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import type { TerminalLayoutSnapshot } from '../../../src/shared/terminal-tab-types'
import { expect } from './orca-app'
import { waitForActiveTerminalManager, waitForPaneCount } from './terminal'

export type RatioCase = {
  label: string
  direction: 'vertical' | 'horizontal'
  supplied?: number
  persisted: number
  tabId: string
}

export async function activateRatioTab(
  page: Page,
  worktreeId: string,
  tabId: string
): Promise<void> {
  await page.evaluate(
    ({ worktreeId, tabId }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Ratio fixture has no renderer store')
      }
      state.setActiveView('terminal')
      state.setActiveWorktree(worktreeId)
      state.setActiveTabForWorktree(worktreeId, tabId)
      state.setActiveTab(tabId)
      state.setActiveTabType('terminal', worktreeId)
    },
    { worktreeId, tabId }
  )
  await waitForActiveTerminalManager(page, 30_000)
}

export async function readRatioGeometry(page: Page, ratioCase: RatioCase) {
  await waitForPaneCount(page, 2, 30_000)
  return page.evaluate(({ tabId, direction }) => {
    const layout = window.__store?.getState().terminalLayoutsByTabId[tabId]
    if (
      layout?.root?.type !== 'split' ||
      layout.root.first.type !== 'leaf' ||
      layout.root.second.type !== 'leaf'
    ) {
      throw new Error('Ratio fixture expected exactly one split and two leaves')
    }
    const firstLeafId = layout.root.first.leafId
    const secondLeafId = layout.root.second.leafId
    const panes = window.__paneManagers?.get(tabId)?.getPanes() ?? []
    const first = panes.find((pane) => pane.leafId === firstLeafId)?.container
    const second = panes.find((pane) => pane.leafId === secondLeafId)?.container
    if (!first || !second || first.parentElement !== second.parentElement || !first.parentElement) {
      throw new Error('Ratio fixture split leaves do not share one rendered parent')
    }
    const box = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    const firstBox = box(first)
    const secondBox = box(second)
    const divider = first.nextElementSibling
    if (!(divider instanceof HTMLElement) || !divider.classList.contains('pane-divider')) {
      throw new Error('Ratio fixture split has no divider between its leaves')
    }
    const parent = box(first.parentElement)
    const horizontalPanes = direction === 'vertical'
    const firstSize = horizontalPanes ? firstBox.width : firstBox.height
    const secondSize = horizontalPanes ? secondBox.width : secondBox.height
    const total = firstSize + secondSize
    return {
      direction,
      dividerOrientation: horizontalPanes ? 'vertical' : 'horizontal',
      paneArrangement: horizontalPanes ? 'left/right' : 'top/bottom',
      first: firstBox,
      second: secondBox,
      divider: box(divider),
      parent,
      dividerPixels: (horizontalPanes ? parent.width : parent.height) - total,
      fractionOfWholeSplit: firstSize / (horizontalPanes ? parent.width : parent.height),
      fraction: firstSize / total,
      availablePixels: total,
      firstFlex: first.style.flex,
      secondFlex: second.style.flex,
      layout
    }
  }, ratioCase)
}

export function assertRatioGeometry(
  geometry: Awaited<ReturnType<typeof readRatioGeometry>>,
  expected: number
): void {
  for (const box of [geometry.first, geometry.second, geometry.parent, geometry.divider]) {
    expect(Object.values(box).every(Number.isFinite)).toBe(true)
  }
  expect(
    [
      geometry.availablePixels,
      geometry.fraction,
      geometry.fractionOfWholeSplit,
      geometry.dividerPixels
    ].every(Number.isFinite)
  ).toBe(true)
  expect(geometry.parent.width).toBeGreaterThan(100)
  expect(geometry.parent.height).toBeGreaterThan(100)
  expect(Math.abs(geometry.dividerPixels)).toBeLessThan(32)
  expect(geometry.divider.width).toBeGreaterThan(0)
  expect(geometry.divider.height).toBeGreaterThan(0)
  expect(geometry.first.width).toBeGreaterThan(0)
  expect(geometry.first.height).toBeGreaterThan(0)
  expect(geometry.second.width).toBeGreaterThan(0)
  expect(geometry.second.height).toBeGreaterThan(0)
  expect(geometry.availablePixels).toBeGreaterThan(100)
  const firstGrow = Number.parseFloat(geometry.firstFlex)
  const secondGrow = Number.parseFloat(geometry.secondFlex)
  expect(Math.abs(firstGrow / (firstGrow + secondGrow) - expected)).toBeLessThan(1e-10)
  expect(Math.abs(geometry.fraction - expected)).toBeLessThanOrEqual(1 / geometry.availablePixels)
  if (geometry.direction === 'vertical') {
    expect(geometry.first.x).toBeLessThan(geometry.second.x)
    expect(Math.abs(geometry.first.y - geometry.second.y)).toBeLessThan(1)
    expect(Math.abs(geometry.first.height - geometry.second.height)).toBeLessThan(1)
  } else {
    expect(geometry.first.y).toBeLessThan(geometry.second.y)
    expect(Math.abs(geometry.first.x - geometry.second.x)).toBeLessThan(1)
    expect(Math.abs(geometry.first.width - geometry.second.width)).toBeLessThan(1)
  }
}

export async function readRatioLayouts(
  page: Page,
  cases: RatioCase[]
): Promise<Record<string, TerminalLayoutSnapshot>> {
  return page.evaluate(
    (tabIds) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Ratio fixture has no renderer store')
      }
      const layouts: Record<string, TerminalLayoutSnapshot> = {}
      for (const tabId of tabIds) {
        const layout = state.terminalLayoutsByTabId[tabId]
        if (!layout) {
          throw new Error(`Ratio fixture lost layout ${tabId}`)
        }
        layouts[tabId] = layout
      }
      return layouts
    },
    cases.map((ratioCase) => ratioCase.tabId)
  )
}

export async function assertHiddenRatioApp(app: ElectronApplication) {
  const identity = await app.evaluate(({ app, BrowserWindow }) => ({
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    pid: process.pid,
    argv: process.argv,
    userData: app.getPath('userData'),
    background: process.env.ORCA_BACKGROUND_LAUNCH,
    windows: BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  }))
  expect(identity.background).toBe('1')
  expect(identity.windows.length).toBeGreaterThan(0)
  expect(identity.windows.every((window) => !window.visible && !window.focused)).toBe(true)
  return identity
}
