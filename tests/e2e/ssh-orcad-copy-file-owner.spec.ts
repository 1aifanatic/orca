import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { startOrcadConvertHost } from './helpers/orcad-convert-host'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { convertAndRetain, serverCall } from './helpers/orcad-convert-flow'
import { waitForSessionReady } from './helpers/store'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { openFileExplorer } from './helpers/file-explorer'
import { shellQuote } from './helpers/docker-ssh-relay-target'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import { getWorktreeHostIdentity } from '../../src/shared/worktree/host-qualified-identity'

import {
  createNativeFileClipboardRecorder,
  installNativeFileClipboardRecorder,
  readNativeFileClipboardRecorder,
  resetNativeFileClipboardRecorder,
  restoreNativeFileClipboardRecorder
} from './helpers/native-file-clipboard-recorder'

const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
test.skip(!TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Needs owned Docker host')
test.skip(process.platform === 'win32', 'Owned POSIX native clipboard recorder')

test('managed file Copy cannot select a same-path desktop file', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(4 * 60_000)
  const fileName = 'COPY_FILE_OWNER.txt'
  const filePath = path.join(testRepoPath, fileName)
  writeFileSync(filePath, 'DESKTOP_COPY_FILE_OWNER\n')
  const intermediate = path.join(testRepoPath, 'intermediate-copy-repo')
  mkdirSync(intermediate)
  execFileSync('git', ['init', '-q', intermediate])
  writeFileSync(path.join(intermediate, 'INTERMEDIATE_OWNER.txt'), 'INTERMEDIATE\n')
  const host = startOrcadConvertHost('docker', testInfo)
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE! })
  let app: ElectronApplication | null = null
  try {
    if (!host.exec) {
      throw new Error('Missing owned host control')
    }
    const execute = host.exec
    execute(
      `mkdir -p ${shellQuote(path.dirname(testRepoPath))} && git clone --quiet ${shellQuote(host.remoteRepoPath)} ${shellQuote(testRepoPath)} && printf 'REMOTE_COPY_FILE_OWNER\n' > ${shellQuote(filePath)}`
    )
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    const ids = await first.page.evaluate(
      async (paths) => {
        const resultIds: string[] = []
        for (const repoPath of paths) {
          const result = await window.api.repos.add({ path: repoPath })
          if ('error' in result) {
            throw new Error(result.error)
          }
          resultIds.push(`${result.repo.id}::${repoPath}`)
        }
        return resultIds
      },
      [testRepoPath, intermediate]
    )
    await session.close(app)
    app = null
    const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
      repoPath: testRepoPath,
      folderPath: host.remoteFolderPath
    })
    const launched = await session.launch()
    app = launched.app
    const page = launched.page
    await waitForSessionReady(page)
    await convertAndRetain(page, session.userDataDir, seeded)
    const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
      (entry) => entry.orcadDeployment?.sshTargetId === seeded.targetId
    )
    if (!environment || !ids[0] || !ids[1]) {
      throw new Error('Missing owned workspace')
    }
    const recorder = createNativeFileClipboardRecorder(testInfo, filePath)
    await installNativeFileClipboardRecorder(app, recorder)
    await dismissTransientAnnouncement(page)
    const localIdentity = getWorktreeHostIdentity({ id: ids[0], hostId: 'local' })
    await page.locator(`[data-worktree-host-identity="${localIdentity}"]:visible`).click()
    await openFileExplorer(page)
    await page
      .locator('[data-file-explorer-row]')
      .filter({ hasText: fileName })
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).click()
    await expect
      .poll(() =>
        readNativeFileClipboardRecorder(app!, recorder).then((receipts) => receipts.length)
      )
      .toBe(1)
    console.log(
      '[legitimate-native-copy-payload]',
      await readNativeFileClipboardRecorder(app, recorder)
    )
    await resetNativeFileClipboardRecorder(app, recorder)
    const middleIdentity = getWorktreeHostIdentity({ id: ids[1], hostId: 'local' })
    await page.locator(`[data-worktree-host-identity="${middleIdentity}"]:visible`).click()
    await openFileExplorer(page)
    await expect(
      page.locator('[data-file-explorer-row]').filter({ hasText: 'INTERMEDIATE_OWNER.txt' })
    ).toBeVisible()
    const remoteIdentity = getWorktreeHostIdentity({
      id: seeded.worktreeId,
      hostId: toRuntimeExecutionHostId(environment.id)
    })
    await page.locator(`[data-worktree-host-identity="${remoteIdentity}"]:visible`).click()
    await openFileExplorer(page)
    const remoteRow = page.locator('[data-file-explorer-row]').filter({ hasText: fileName })
    await expect(remoteRow).toBeVisible()
    console.log(
      '[actual-managed-file-before-copy]',
      await serverCall(page, environment.id, 'files.read', {
        worktree: `id:${seeded.worktreeId}`,
        relativePath: fileName
      })
    )
    await remoteRow.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: /^Copy Path/ })).toBeVisible()
    await expect(page.getByRole('menu')).toHaveCSS('opacity', '1')
    const copy = page.getByRole('menuitem', { name: 'Copy', exact: true })
    const offered = (await copy.count()) > 0
    await page.screenshot({ path: testInfo.outputPath('managed-file-copy-menu.png') })
    if (offered) {
      await copy.click()
      await expect
        .poll(() =>
          readNativeFileClipboardRecorder(app!, recorder).then((receipts) => receipts.length)
        )
        .toBe(1)
    }
    const receipts = await readNativeFileClipboardRecorder(app, recorder)
    console.log('[managed-copy-native-file-payload]', receipts)
    expect(readFileSync(filePath, 'utf8')).toBe('DESKTOP_COPY_FILE_OWNER\n')
    expect(receipts).toEqual([])
    await expect(copy).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Download', exact: true })).toBeVisible()
  } finally {
    try {
      if (app) {
        try {
          await restoreNativeFileClipboardRecorder(app)
        } finally {
          await session.close(app)
        }
      }
      await session.dispose()
    } finally {
      host.cleanup()
    }
  }
})
