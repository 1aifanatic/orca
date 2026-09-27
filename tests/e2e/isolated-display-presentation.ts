import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'

/**
 * Shared fail-closed guard for the isolated-display exceptions documented in
 * tests/AGENTS.md. Each caller owns its own opt-in flag; a flag set anywhere other
 * than a GitHub-hosted Linux runner with its own Xvfb display is an error, never a
 * silent downgrade to presenting.
 */

export type IsolatedDisplayEnv = Readonly<Record<string, string | undefined>>

export type IsolatedDisplayExemption = {
  /** Opt-in env flag, unique per exemption so one never enables another. */
  flag: string
  /** Error text when the flag is set outside an owned hosted Linux display. */
  requirement: string
  /** testInfo annotation type recorded after confirmed presentation. */
  annotation: string
  /** Error text when the window did not become visible. */
  absent: string
}

export function shouldPresentOnIsolatedDisplay(
  exemption: IsolatedDisplayExemption,
  env: IsolatedDisplayEnv = process.env,
  platform: string = process.platform
): boolean {
  if (env[exemption.flag] !== '1') {
    return false
  }
  if (
    platform !== 'linux' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    !env.DISPLAY
  ) {
    throw new Error(exemption.requirement)
  }
  return true
}

/** Presents without focus. Resolves true only when presentation was confirmed. */
export async function presentOnIsolatedDisplay(
  exemption: IsolatedDisplayExemption,
  electronApp: Pick<ElectronApplication, 'evaluate'>,
  testInfo: Pick<TestInfo, 'annotations'>
): Promise<boolean> {
  if (!shouldPresentOnIsolatedDisplay(exemption)) {
    return false
  }
  // An unpresented Linux window triggers Chromium's one-second undrawn-frame throttle.
  const visible = await electronApp.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    for (const window of windows) {
      window.showInactive()
    }
    return windows.length > 0 && windows.every((window) => window.isVisible())
  })
  if (!visible) {
    throw new Error(exemption.absent)
  }
  testInfo.annotations.push({ type: exemption.annotation, description: 'isolated-xvfb' })
  return true
}
