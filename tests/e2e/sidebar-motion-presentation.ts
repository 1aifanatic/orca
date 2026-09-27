import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'
import {
  type IsolatedDisplayEnv,
  presentOnIsolatedDisplay,
  shouldPresentOnIsolatedDisplay
} from './isolated-display-presentation'

/**
 * Diagnostic-only exemption for the sidebar hidden-vs-mapped frame experiment. Its
 * flag is distinct from the terminal benchmark's and is set only inside the
 * diagnostic workflow's owned xvfb-run; every other run stays windowless.
 */
const sidebarMotionExemption = {
  flag: 'ORCA_E2E_SIDEBAR_MOTION_XVFB',
  requirement: 'Sidebar motion presentation requires an isolated GitHub Actions Xvfb display',
  annotation: 'sidebar-motion-presentation',
  absent: 'Sidebar motion window was not presented on the isolated display'
} as const

export function shouldPresentSidebarMotionWindow(
  env: IsolatedDisplayEnv = process.env,
  platform: string = process.platform
): boolean {
  return shouldPresentOnIsolatedDisplay(sidebarMotionExemption, env, platform)
}

export type SidebarMotionPresentation = {
  presented: boolean
  windows: number
  visible: number
  display: string | null
}

export async function presentSidebarMotionWindow(
  electronApp: Pick<ElectronApplication, 'evaluate'>,
  testInfo: Pick<TestInfo, 'annotations'>
): Promise<SidebarMotionPresentation> {
  const presented = await presentOnIsolatedDisplay(sidebarMotionExemption, electronApp, testInfo)
  if (!presented) {
    return { presented: false, windows: 0, visible: 0, display: null }
  }
  // Diagnostic evidence only; presentOnIsolatedDisplay already proved every window is visible.
  const counts = await electronApp.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    return { windows: windows.length, visible: windows.filter((window) => window.isVisible()).length }
  })
  return { presented: true, ...counts, display: process.env.DISPLAY ?? null }
}
