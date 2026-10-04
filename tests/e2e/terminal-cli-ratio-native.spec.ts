import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { z } from 'zod'
import { runProcess } from '../../src/shared/child-process/run-process'
import type { ProcessResult } from '../../src/shared/child-process/process-spec'
import type { RuntimeTerminalSummary } from '../../src/shared/runtime-types'
import { parseWorkspaceSession } from '../../src/shared/workspace-session-schema'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { readPersistedProfileState } from './helpers/persisted-profile-state'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  activateRatioTab,
  assertHiddenRatioApp,
  assertRatioGeometry,
  readRatioGeometry,
  readRatioLayouts,
  type RatioCase
} from './helpers/terminal-cli-ratio-geometry'
import {
  cleanupRatioDaemon,
  recordRatioDaemon,
  stopRatioDaemon
} from './helpers/terminal-cli-ratio-daemon'
import {
  createRatioTerminal,
  ratioLaunchEnv,
  runRatioCli,
  splitRatioTerminal,
  waitForRatioTerminals
} from './helpers/terminal-cli-ratio-runtime'

const shellReceipt = z.object({
  pid: z.number().int().positive(),
  ppid: z.number().int().positive(),
  at: z.number()
})
const ratioValues = [
  { label: 'default', persisted: 0.5 },
  { label: '85-percent', supplied: 0.85, persisted: 0.85 },
  { label: 'rounded-third', supplied: 0.3333, persisted: 0.333 },
  { label: 'small-positive', supplied: 0.0001, persisted: 0.0001 }
]

test('native CLI ratios preserve both pane arrangements through a cold daemon restart', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const session = createRestartSession(testInfo, { ORCA_BACKGROUND_LAUNCH: '1' })
  const cases: RatioCase[] = []
  const evidence: Record<string, unknown> = {
    productBaseHead: 'a1cccc313670606b3f89c2d2c2cda7d660903dc3',
    platform: process.platform,
    coldRestart:
      'graceful app quit followed by termination of its authenticated owned daemon; not a power loss',
    geometryTolerance:
      'one CSS pixel divided by both pane extents; divider extent recorded separately',
    cases,
    completed: false
  }
  const evidencePath = testInfo.outputPath('terminal-cli-ratio-native.json')
  const saveEvidence = () => writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  let app: ElectronApplication | undefined
  let completed = false
  let cleaned = false
  try {
    const checkout = await runProcess({
      program: 'git',
      args: ['rev-parse', 'HEAD', 'HEAD^{tree}'],
      cwd: process.cwd(),
      timeoutMs: 5_000
    })
    expect(checkout.code).toBe(0)
    evidence.checkout = checkout.stdout.trim().split('\n')
    evidence.compiled = ['out/main/index.js', 'out/main/daemon-entry.js', 'out/cli/index.js'].map(
      (file) => ({
        file,
        sha256: createHash('sha256').update(readFileSync(file)).digest('hex')
      })
    )
    saveEvidence()

    const first = await session.launch({ extraEnv: ratioLaunchEnv(session.userDataDir) })
    app = first.app
    evidence.firstApp = await assertHiddenRatioApp(app)
    expect(evidence.firstApp).toMatchObject({ userData: session.userDataDir })
    const worktreeId = await attachRepoAndOpenTerminal(first.page, testRepoPath)
    await waitForSessionReady(first.page)
    await ensureTerminalVisible(first.page)
    const cliRuns: { label: string; create: ProcessResult; split: ProcessResult }[] = []
    const beforeGeometry: {
      label: string
      geometry: Awaited<ReturnType<typeof readRatioGeometry>>
    }[] = []
    const beforeTerminals: RuntimeTerminalSummary[] = []
    for (const direction of ['vertical', 'horizontal'] as const) {
      for (const value of ratioValues) {
        const label = `${direction}-${value.label}`
        const created = await createRatioTerminal(session.userDataDir, worktreeId, label)
        await activateRatioTab(first.page, worktreeId, created.terminal.tabId)
        await waitForRatioTerminals(session.userDataDir, worktreeId, created.terminal.tabId, 1)
        const split = await splitRatioTerminal(
          session.userDataDir,
          created.terminal.handle,
          direction,
          value.supplied
        )
        expect(split.split.tabId).toBe(created.terminal.tabId)
        const ratioCase: RatioCase = { ...value, label, direction, tabId: created.terminal.tabId }
        cases.push(ratioCase)
        const terminals = await waitForRatioTerminals(
          session.userDataDir,
          worktreeId,
          ratioCase.tabId,
          2
        )
        beforeTerminals.push(...terminals)
        const geometry = await readRatioGeometry(first.page, ratioCase)
        assertRatioGeometry(geometry, value.supplied ?? 0.5)
        expect(
          geometry.layout.root?.type === 'split' ? (geometry.layout.root.ratio ?? 0.5) : null
        ).toBe(value.persisted)
        cliRuns.push({ label, create: created.raw, split: split.raw })
        beforeGeometry.push({ label, geometry })
        await first.page.screenshot({
          path: testInfo.outputPath(`terminal-cli-ratio-before-${label}.png`)
        })
        evidence.cliRuns = cliRuns
        evidence.beforeGeometry = beforeGeometry
        saveEvidence()
      }
    }
    evidence.beforeHidden = await assertHiddenRatioApp(app)
    const beforeLayouts = await readRatioLayouts(first.page, cases)
    const beforePtyIds = beforeTerminals.flatMap((terminal) =>
      terminal.ptyId ? [terminal.ptyId] : []
    )
    expect(new Set(beforePtyIds).size).toBe(16)
    const oldDaemon = await recordRatioDaemon(session.userDataDir, beforePtyIds)
    evidence.beforeTerminals = beforeTerminals
    evidence.oldDaemon = oldDaemon
    evidence.beforeLayouts = beforeLayouts
    saveEvidence()

    await session.close(app)
    app = undefined
    const persisted = readPersistedProfileState(session.userDataDir)
    const parsed = parseWorkspaceSession(persisted.workspaceSession)
    if (!parsed.ok) {
      throw new Error(`Cold ratio fixture persisted session is invalid: ${parsed.error}`)
    }
    const persistedLayouts = Object.fromEntries(
      cases.map((ratioCase) => [
        ratioCase.tabId,
        parsed.value.terminalLayoutsByTabId[ratioCase.tabId]
      ])
    )
    expect(persistedLayouts).toEqual(beforeLayouts)
    evidence.persistedLayouts = persistedLayouts
    evidence.coldStop = await stopRatioDaemon(oldDaemon)
    saveEvidence()

    const second = await session.launch({ extraEnv: ratioLaunchEnv(session.userDataDir) })
    app = second.app
    evidence.secondApp = await assertHiddenRatioApp(app)
    expect(evidence.secondApp).toMatchObject({ userData: session.userDataDir })
    await waitForSessionReady(second.page)
    const afterGeometry: typeof beforeGeometry = []
    const afterTerminals: RuntimeTerminalSummary[] = []
    const nativeWrites: {
      label: string
      terminal: RuntimeTerminalSummary
      sent: ProcessResult
      receipt: z.infer<typeof shellReceipt>
    }[] = []
    for (const ratioCase of cases) {
      await activateRatioTab(second.page, worktreeId, ratioCase.tabId)
      const terminals = await waitForRatioTerminals(
        session.userDataDir,
        worktreeId,
        ratioCase.tabId,
        2
      )
      afterTerminals.push(...terminals)
      const geometry = await readRatioGeometry(second.page, ratioCase)
      assertRatioGeometry(geometry, ratioCase.persisted)
      expect(geometry.layout).toEqual(persistedLayouts[ratioCase.tabId])
      afterGeometry.push({ label: ratioCase.label, geometry })
      for (const terminal of terminals) {
        const markerPath = path.join(
          session.userDataDir,
          `${ratioCase.label}-${terminal.leafId}.json`
        )
        const encodedPath = Buffer.from(markerPath).toString('base64')
        const command = `node -e "require('fs').writeFileSync(Buffer.from('${encodedPath}','base64').toString(),JSON.stringify({pid:process.pid,ppid:process.ppid,at:Date.now()}))"`
        const sent = await runRatioCli(session.userDataDir, [
          'terminal',
          'send',
          '--terminal',
          terminal.handle,
          '--text',
          command,
          '--enter'
        ])
        await expect
          .poll(() => existsSync(markerPath), {
            timeout: 15_000,
            message: `Restored native shell ${terminal.handle} did not execute its receipt command`
          })
          .toBe(true)
        const receipt = shellReceipt.parse(JSON.parse(readFileSync(markerPath, 'utf8')))
        nativeWrites.push({ label: ratioCase.label, terminal, sent, receipt })
      }
      await second.page.screenshot({
        path: testInfo.outputPath(`terminal-cli-ratio-after-${ratioCase.label}.png`)
      })
      evidence.afterGeometry = afterGeometry
      evidence.nativeWrites = nativeWrites
      saveEvidence()
    }
    const afterPtyIds = afterTerminals.flatMap((terminal) =>
      terminal.ptyId ? [terminal.ptyId] : []
    )
    expect(new Set(afterPtyIds).size).toBe(16)
    const newDaemon = await recordRatioDaemon(session.userDataDir, afterPtyIds)
    expect(newDaemon.record.pid).not.toBe(oldDaemon.record.pid)
    expect(newDaemon.record.launchNonce).not.toBe(oldDaemon.record.launchNonce)
    for (const session of newDaemon.sessions) {
      expect(oldDaemon.sessions.some((old) => old.pid === session.pid)).toBe(false)
      const old = oldDaemon.sessions.find((old) => old.sessionId === session.sessionId)
      expect(session.incarnationId).not.toBe(old?.incarnationId)
    }
    for (const write of nativeWrites) {
      const shell = newDaemon.sessions.find((session) => session.sessionId === write.terminal.ptyId)
      expect(
        shell?.pid,
        `Receipt for ${write.terminal.handle} must identify its authenticated native shell`
      ).toBe(write.receipt.ppid)
    }
    evidence.afterTerminals = afterTerminals
    evidence.newDaemon = newDaemon
    evidence.afterLayouts = await readRatioLayouts(second.page, cases)
    expect(evidence.afterLayouts).toEqual(persistedLayouts)
    evidence.afterHidden = await assertHiddenRatioApp(app)
    completed = true
  } catch (error) {
    evidence.failure = {
      message: String(error),
      stack: error instanceof Error ? error.stack : undefined
    }
    if (app) {
      await app
        .firstWindow()
        .then((page) =>
          page.screenshot({ path: testInfo.outputPath('terminal-cli-ratio-failure.png') })
        )
        .catch(() => {})
    }
    throw error
  } finally {
    try {
      if (app) {
        await session.close(app)
      }
      evidence.daemonCleanup = await cleanupRatioDaemon(session.userDataDir)
      await session.dispose()
      evidence.cleanup = {
        appClosed: true,
        ownedProfileDisposed: !existsSync(session.userDataDir),
        at: new Date().toISOString()
      }
      expect(existsSync(session.userDataDir)).toBe(false)
      cleaned = true
    } catch (error) {
      evidence.cleanupFailure = String(error)
    } finally {
      evidence.completed = completed && cleaned
      saveEvidence()
      await testInfo.attach('native CLI ratio and cold restart evidence', {
        path: evidencePath,
        contentType: 'application/json'
      })
    }
  }
  expect(cleaned, 'The fixture must verify and dispose its owned processes/profile').toBe(true)
})
