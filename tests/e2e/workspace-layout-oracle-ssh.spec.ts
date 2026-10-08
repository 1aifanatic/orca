/**
 * Layout oracle over an SSH worktree with the window attached: the remote worktree's layout lives
 * in its `ssh:<target>` partition, and every check (rules, view, client, expected, restart, marker)
 * runs against it across a split, a tab close and a relaunch that reconnects the target.
 *
 * Findings main still has are listed in `workspace-layout-oracle-known-on-main.ts`; any other
 * finding fails. `ORCA_LAYOUT_ORACLE_RECORD=1` records without failing.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { SORTABLE_TAB } from './helpers/terminal-tab-menu'
import { waitForBoundPanes } from './helpers/terminal-layout-journeys'
import { createRemoteTerminalTab } from './helpers/docker-ssh-relay-terminal-tabs'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { runOracleScenario } from './helpers/workspace-layout-oracle-session'
import { oracleWorktreeKey, toOracleLayout } from './helpers/workspace-layout-oracle-model'
import { readRuntimePartitions } from './helpers/workspace-layout-oracle-views'
import { toSshExecutionHostId } from '../../src/shared/execution-host'
import { unexpectedFindings } from './workspace-layout-oracle-known-on-main'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const RECORD_ONLY = process.env.ORCA_LAYOUT_ORACLE_RECORD === '1'
const REPEAT = Math.max(1, Number(process.env.ORCA_LAYOUT_ORACLE_REPEAT ?? 1))
const SCENARIO_ID = 'ssh-split-close-restart'

test.use({ seedTestRepo: false })

/** Proves the quit will restore the target: tabs and the active connection are persisted. */
async function waitForPersistedRemoteSession(
  page: Page,
  targetId: string,
  worktreeId: string
): Promise<void> {
  const hostId = toSshExecutionHostId(targetId)
  await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ targetId, worktreeId, hostId }) => {
            const tabIds = (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).map(
              (tab) => tab.id
            )
            const [local, host] = await Promise.all([
              window.api.session.get(),
              window.api.session.get(hostId)
            ])
            const persisted = new Set(
              [
                ...(local.tabsByWorktree[worktreeId] ?? []),
                ...(host.tabsByWorktree[worktreeId] ?? [])
              ].map((tab) => tab.id)
            )
            return (
              local.activeConnectionIdsAtShutdown?.includes(targetId) === true &&
              tabIds.length > 0 &&
              tabIds.every((id) => persisted.has(id))
            )
          },
          { targetId, worktreeId, hostId }
        ),
      { timeout: 15_000, message: 'SSH tabs and active target were not persisted before quit' }
    )
    .toBe(true)
}

/** The relaunched window reconnects the target on its own and reopens the remote worktree. */
async function waitForRestoredRemoteWorktree(
  page: Page,
  targetId: string,
  worktreeId: string
): Promise<void> {
  await waitForSessionReady(page, 60_000)
  await expect.poll(() => waitForActiveWorktree(page), { timeout: 60_000 }).toBe(worktreeId)
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => window.__store?.getState().sshConnectionStates.get(id)?.status,
          targetId
        ),
      { timeout: 90_000, message: 'renderer SSH state did not restore' }
    )
    .toBe('connected')
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)
}

test.describe('workspace layout oracle over SSH', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH targets use POSIX SSH tooling.')

  for (let attempt = 1; attempt <= REPEAT; attempt += 1) {
    const suffix = REPEAT > 1 ? ` #${attempt}` : ''
    // oxlint-disable-next-line no-empty-pattern -- The scenario owns every launch.
    test(`layout oracle: ${SCENARIO_ID}${suffix}`, async ({}, testInfo) => {
      test.setTimeout(600_000)
      let target: DockerSshRelayTarget | null = null
      try {
        target = startDockerSshRelayTarget(testInfo)
        const sshTarget = target
        const findings = await runOracleScenario(testInfo, SCENARIO_ID, async (run) => {
          await waitForSessionReady(run.page)
          const remote = await connectDockerSshRelayTarget(run.page, sshTarget)
          const worktreeId = remote.worktreeId
          run.worktreeIds.push(worktreeId)
          await expect
            .poll(() => waitForActiveWorktree(run.page), { timeout: 30_000 })
            .toBe(worktreeId)
          await waitForActiveTerminalManager(run.page, 60_000)
          await waitForBoundPanes(run.page, 1)
          const remoteKey = oracleWorktreeKey(toSshExecutionHostId(remote.targetId), worktreeId)
          // Presence precondition: the checks below must be reading the SSH partition.
          const connected = await run.oracle.step('connect', { worktreeId, panesPerTab: [1] })
          expect(Object.keys(connected)).toContain(remoteKey)

          await createRemoteTerminalTab(run.page, worktreeId)
          await waitForBoundPanes(run.page, 1)
          await run.oracle.step('remote new tab', { worktreeId, panesPerTab: [1, 1] })

          await splitActiveTerminalPane(run.page, 'vertical')
          await waitForBoundPanes(run.page, 2)
          await run.oracle.step('split remote tab', { worktreeId, panesPerTab: [1, 2] })

          const tabs = run.page.locator(SORTABLE_TAB)
          await tabs
            .first()
            .getByRole('button', { name: /^Close tab /i })
            .click()
          await expect(tabs).toHaveCount(1)
          await run.oracle.step('close first tab', { worktreeId, panesPerTab: [2] })

          await waitForPersistedRemoteSession(run.page, remote.targetId, worktreeId)
          await run.relaunch({
            worktreeId,
            paneCount: 2,
            panesPerTab: [2],
            reopen: (page, id) => waitForRestoredRemoteWorktree(page, remote.targetId, id)
          })
          const restored = toOracleLayout(await readRuntimePartitions(run.page))
          expect(Object.keys(restored)).toContain(remoteKey)
          const marked = await run.oracle.checkMarkers('after relaunch', worktreeId)
          console.log(`[layout-oracle] ${SCENARIO_ID}: markers written to ${marked} remote panes`)
        })
        for (const finding of findings) {
          console.log(
            `[layout-oracle] ${SCENARIO_ID}: ${finding.check} @ ${finding.step}\n  ${finding.details.join('\n  ')}`
          )
        }
        if (!RECORD_ONLY) {
          expect(unexpectedFindings(SCENARIO_ID, findings)).toEqual([])
        }
      } finally {
        cleanupDockerSshRelayTarget(target)
      }
    })
  }
})
