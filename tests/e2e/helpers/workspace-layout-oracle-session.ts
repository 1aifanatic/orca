/**
 * One windowed Orca under the layout oracle: launch, relaunch (optionally with a cold PTY daemon),
 * and a report of every finding per scenario.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../../src/cli/runtime/client'
import { PROTOCOL_VERSION } from '../../../src/main/daemon/types'
import { expect } from './orca-app'
import { createRestartSession } from './orca-restart'
import { bootstrapRestoredLaunch } from './terminal-restart-persistence'
import { waitForPaneCount } from './terminal'
import { LayoutOracle, type OracleFinding } from './workspace-layout-oracle'
import { readRuntimePartitions } from './workspace-layout-oracle-views'

export const ORACLE_REPORT_DIR_ENV = 'ORCA_LAYOUT_ORACLE_REPORT_DIR'

export type OracleRun = {
  page: Page
  userDataDir: string
  client: RuntimeClient
  oracle: LayoutOracle
  /** Worktrees the client checks compare; scenarios add the ones they create. */
  worktreeIds: string[]
  /** Quit, optionally kill the PTY daemon, relaunch, and diff the layout against before. */
  relaunch: (options: {
    worktreeId: string
    paneCount: number
    coldDaemon?: boolean
    /** Panes per terminal tab the relaunched runtime must hold. */
    panesPerTab?: number[]
    reopen?: (page: Page, worktreeId: string) => Promise<void>
  }) => Promise<void>
}

function readDaemonPid(userDataDir: string): number | null {
  try {
    const raw = readFileSync(
      path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`),
      'utf8'
    )
    const pid: unknown = JSON.parse(raw).pid
    return typeof pid === 'number' ? pid : null
  } catch {
    return null
  }
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error
    }
  }
}

export async function runOracleScenario(
  testInfo: TestInfo,
  scenarioId: string,
  body: (run: OracleRun) => Promise<void>
): Promise<OracleFinding[]> {
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  const worktreeIds: string[] = []
  try {
    const first = await session.launch()
    app = first.app
    const target = (page: Page, client: RuntimeClient) => ({
      page,
      client,
      readPartitions: () => readRuntimePartitions(page),
      worktreeIds: () => worktreeIds
    })
    const client = new RuntimeClient(session.userDataDir, 30_000)
    const run: OracleRun = {
      page: first.page,
      userDataDir: session.userDataDir,
      client,
      oracle: new LayoutOracle(target(first.page, client)),
      worktreeIds,
      relaunch: async ({ worktreeId, paneCount, coldDaemon, panesPerTab, reopen }) => {
        const before = await run.oracle.step('before relaunch')
        run.oracle.rememberForRestart(before)
        await session.close(app!)
        app = null
        const daemonPid = coldDaemon ? readDaemonPid(session.userDataDir) : null
        if (coldDaemon) {
          expect(daemonPid, 'the PTY daemon pid file is missing').not.toBeNull()
          killProcess(daemonPid!)
        }
        const next = await session.launch()
        app = next.app
        run.page = next.page
        run.client = new RuntimeClient(session.userDataDir, 30_000)
        run.oracle.retarget(target(next.page, run.client))
        await (reopen ?? bootstrapRestoredLaunch)(next.page, worktreeId)
        await waitForPaneCount(next.page, paneCount, 30_000).catch(() => {})
        const after = await run.oracle.step(
          coldDaemon ? 'after cold relaunch' : 'after relaunch',
          panesPerTab ? { worktreeId, panesPerTab } : undefined
        )
        run.oracle.compareRestart(coldDaemon ? 'cold relaunch' : 'relaunch', after, {
          maskPtyIds: coldDaemon
        })
      }
    }
    await body(run)
    writeReport(testInfo, scenarioId, run.oracle.findings)
    return run.oracle.findings
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
}

function writeReport(testInfo: TestInfo, scenarioId: string, findings: OracleFinding[]): void {
  const dir = process.env[ORACLE_REPORT_DIR_ENV] ?? testInfo.outputPath('layout-oracle')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${scenarioId}-${Date.now()}.json`)
  writeFileSync(file, `${JSON.stringify({ scenario: scenarioId, findings }, null, 2)}\n`)
}
