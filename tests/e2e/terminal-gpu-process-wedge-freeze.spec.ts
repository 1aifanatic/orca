import { execFileSync } from 'node:child_process'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { retryTransientMainEvaluate } from './helpers/electron-main-evaluate-retry'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  resolveActiveTabId,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'

// Crash report 1790848817.677819 (Windows, NVIDIA D3D11): the GPU process exited
// (34) 8ms after a settled-reveal atlas reset, a GPU process with a 0 MB working
// set then lingered, and the renderer ran no JS for 9 minutes until the user
// killed Orca. A plain GPU kill recovers; a GPU process that stops making
// progress does not. Suspending it stands in for the driver wedge; main's
// renderer GPU-stall watchdog must kill it so the renderer runs JS again.

const RENDERER_PROBE_TIMEOUT_MS = 5_000
// Covers the watchdog's ping interval + stall timeout, with slack for a cold GPU relaunch.
const RENDERER_RECOVERY_TIMEOUT_MS = 30_000
const PANE_COUNT = 4
// Why node: one command line that zsh, PowerShell and cmd all run unchanged.
const STREAM_COMMAND =
  'node -e "setInterval(function(){for(var i=0;i<200;i++)console.log(Date.now()+\' stream \'+i)},5)"'

type WorktreePair = { firstWorktreeId: string; otherWorktreeId: string }
type RendererProbe = { responsive: true; heartbeatAgeMs: number } | { responsive: false }

async function gpuPids(app: ElectronApplication): Promise<number[]> {
  return retryTransientMainEvaluate(() =>
    app.evaluate(({ app: electronApp }) =>
      electronApp
        .getAppMetrics()
        .filter((metric) => metric.type === 'GPU')
        .map((metric) => metric.pid)
    )
  )
}

function setProcessSuspended(pid: number, suspended: boolean): void {
  if (process.platform !== 'win32') {
    process.kill(pid, suspended ? 'SIGSTOP' : 'SIGCONT')
    return
  }
  const call = suspended ? 'NtSuspendProcess' : 'NtResumeProcess'
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `$t = Add-Type -Name N -Namespace W -PassThru -MemberDefinition '[DllImport("ntdll.dll")] public static extern int ${call}(IntPtr h);'; [void]$t::${call}([Diagnostics.Process]::GetProcessById(${pid}).Handle)`
  ])
}

function resumeIfAlive(pid: number): void {
  try {
    setProcessSuspended(pid, false)
  } catch {
    // The watchdog already killed it.
  }
}

async function probeRenderer(page: Page): Promise<RendererProbe> {
  const probe = page
    .evaluate(() => {
      const heartbeat: unknown = Reflect.get(window, '__gpuWedgeHeartbeat')
      const lastBeat = typeof heartbeat === 'number' ? heartbeat : 0
      return { responsive: true as const, heartbeatAgeMs: Date.now() - lastBeat }
    })
    .catch((): RendererProbe => ({ responsive: false }))
  const timeout = new Promise<RendererProbe>((resolve) =>
    setTimeout(() => resolve({ responsive: false }), RENDERER_PROBE_TIMEOUT_MS)
  )
  return Promise.race([probe, timeout])
}

function isHealthy(probe: RendererProbe): boolean {
  return probe.responsive && probe.heartbeatAgeMs < 1_500
}

async function waitForHealthyRenderer(page: Page): Promise<RendererProbe> {
  const deadline = Date.now() + RENDERER_RECOVERY_TIMEOUT_MS
  let probe = await probeRenderer(page)
  while (!isHealthy(probe) && Date.now() < deadline) {
    probe = await probeRenderer(page)
  }
  return probe
}

async function webglPaneCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    let count = 0
    for (const manager of window.__paneManagers?.values() ?? []) {
      count += (manager.getRenderingDiagnostics?.() ?? []).filter((d) => d.hasWebgl).length
    }
    return count
  })
}

async function setTerminalGpuAcceleration(page: Page, mode: 'on' | 'off'): Promise<void> {
  await page.evaluate((nextMode) => {
    const state = window.__store?.getState()
    if (!state?.settings) {
      throw new Error('Store unavailable')
    }
    window.__store?.setState({ settings: { ...state.settings, terminalGpuAcceleration: nextMode } })
    for (const manager of window.__paneManagers?.values() ?? []) {
      manager.setTerminalGpuAcceleration(nextMode)
    }
  }, mode)
}

async function startStreamingPanes(page: Page): Promise<void> {
  for (let index = 1; index < PANE_COUNT; index += 1) {
    await splitActiveTerminalPane(page, index % 2 === 0 ? 'horizontal' : 'vertical')
    await waitForPaneCount(page, index + 1)
  }
  const tabId = await resolveActiveTabId(page)
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => (id ? (window.__store?.getState().ptyIdsByTabId[id]?.length ?? 0) : 0),
          tabId
        ),
      { timeout: 20_000 }
    )
    .toBe(PANE_COUNT)
  // Why: a command typed before the shell prompt can be swallowed by startup.
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  await page.evaluate(
    ({ id, command }) => {
      for (const ptyId of (id ? window.__store?.getState().ptyIdsByTabId[id] : null) ?? []) {
        window.api.pty.write(String(ptyId), `${command}\r`, 'driving')
      }
    },
    { id: tabId, command: STREAM_COMMAND }
  )
}

async function setUpStreamingWorkspace(page: Page, mode: 'on' | 'off'): Promise<WorktreePair> {
  await waitForSessionReady(page)
  const firstWorktreeId = await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  await setTerminalGpuAcceleration(page, mode)
  await startStreamingPanes(page)
  await setTerminalGpuAcceleration(page, mode)
  await expect.poll(() => getTerminalContent(page), { timeout: 20_000 }).toContain(' stream ')
  if (mode === 'on') {
    await expect.poll(() => webglPaneCount(page), { timeout: 15_000 }).toBeGreaterThan(0)
  }
  const otherWorktreeId = (await getAllWorktreeIds(page)).find((id) => id !== firstWorktreeId)
  if (!otherWorktreeId) {
    throw new Error('Seeded repo needs a second worktree')
  }
  await page.evaluate(() => {
    Reflect.set(window, '__gpuWedgeHeartbeat', Date.now())
    setInterval(() => Reflect.set(window, '__gpuWedgeHeartbeat', Date.now()), 100)
  })
  return { firstWorktreeId, otherWorktreeId }
}

// Each switch reveals the other workspace's terminals: reattach + settled-reveal atlas reset.
async function revealWorktree(page: Page, ids: WorktreePair, round: number): Promise<void> {
  await switchToWorktree(page, round % 2 === 0 ? ids.otherWorktreeId : ids.firstWorktreeId)
  if (round % 2 === 1) {
    await ensureTerminalVisible(page)
  }
}

async function expectRendererSurvivesReveals(
  page: Page,
  ids: WorktreePair,
  label: string
): Promise<void> {
  const timeline: string[] = []
  for (let round = 0; round < 3; round += 1) {
    await revealWorktree(page, ids, round)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    const probe = await waitForHealthyRenderer(page)
    timeline.push(`${label} reveal=${round} probe=${JSON.stringify(probe)}`)
    if (!isHealthy(probe)) {
      break
    }
  }
  expect(
    timeline.length === 3 && timeline.every((entry) => entry.includes('"responsive":true')),
    timeline.join('\n')
  ).toBe(true)
}

test.describe('terminal renderer when the GPU process stops making progress', () => {
  test('a plain GPU process crash during a settled reveal does not freeze the renderer', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(240_000)
    const ids = await setUpStreamingWorkspace(orcaPage, 'on')
    // Why 3: Chromium aborts the browser after its sixth GPU death in a session.
    for (let round = 0; round < 3; round += 1) {
      await revealWorktree(orcaPage, ids, round)
      await new Promise((resolve) => setTimeout(resolve, 40))
      const [pid] = await gpuPids(electronApp)
      process.kill(pid!, 'SIGKILL')
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      expect(isHealthy(await probeRenderer(orcaPage))).toBe(true)
    }
  })

  for (const mode of ['on', 'off'] as const) {
    test(`renderer recovers across reveals while the GPU process is wedged (terminal GPU ${mode})`, async ({
      orcaPage,
      electronApp
    }) => {
      test.setTimeout(240_000)
      const ids = await setUpStreamingWorkspace(orcaPage, mode)
      const [gpuPid] = await gpuPids(electronApp)
      expect(gpuPid).toBeTruthy()
      setProcessSuspended(gpuPid!, true)
      try {
        await expectRendererSurvivesReveals(orcaPage, ids, `mode=${mode}`)
      } finally {
        resumeIfAlive(gpuPid!)
      }
    })
  }

  test('renderer recovers when the GPU dies mid atlas reset and its replacement wedges', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(240_000)
    const ids = await setUpStreamingWorkspace(orcaPage, 'on')
    await revealWorktree(orcaPage, ids, 0)
    await new Promise((resolve) => setTimeout(resolve, 40))
    const [killedPid] = await gpuPids(electronApp)
    process.kill(killedPid!, 'SIGKILL')
    let wedgedPid: number | undefined
    const deadline = Date.now() + 10_000
    while (wedgedPid === undefined && Date.now() < deadline) {
      wedgedPid = (await gpuPids(electronApp)).find((pid) => pid !== killedPid)
    }
    expect(wedgedPid).toBeTruthy()
    setProcessSuspended(wedgedPid!, true)
    try {
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      const afterCrash = await waitForHealthyRenderer(orcaPage)
      expect(afterCrash.responsive, `after crash probe=${JSON.stringify(afterCrash)}`).toBe(true)
      await expectRendererSurvivesReveals(orcaPage, { ...ids }, 'relaunch-wedged')
    } finally {
      resumeIfAlive(wedgedPid!)
    }
  })
})
