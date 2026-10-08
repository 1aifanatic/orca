import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { startOrcadConvertHost } from './helpers/orcad-convert-host'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { convertAndRetain, serverCall } from './helpers/orcad-convert-flow'
import { waitForSessionReady } from './helpers/store'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { shellQuote } from './helpers/docker-ssh-relay-target'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import { getWorktreeHostIdentity } from '../../src/shared/worktree/host-qualified-identity'
import {
  installEditorSaveIpcBarrier,
  readEditorSaveIpcBarrier,
  releaseEditorSaveIpcBarrier,
  restoreEditorSaveIpcBarrier
} from './helpers/editor-save-ipc-barrier'

const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
test.skip(!TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Needs owned Docker host')
test.skip(process.platform === 'win32', 'Owned POSIX SSH fixture')

for (const managed of [true, false]) {
  for (const bulk of [false, true]) {
    test(`${managed ? 'managed' : 'desktop'} ${bulk ? 'bulk' : 'single'} discard waits for an in-flight editor save`, async ({
      testRepoPath
    }, testInfo) => {
      test.setTimeout(4 * 60_000)
      const host = managed ? startOrcadConvertHost('docker', testInfo) : null
      const session = createRestartSession(
        testInfo,
        managed ? { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE! } : {}
      )
      let app: ElectronApplication | null = null
      try {
        const repoPath = host?.remoteRepoPath ?? testRepoPath
        const fileName = `DISCARD_OWNER_${bulk ? 'BULK' : 'SINGLE'}.txt`
        const otherFileName = `DISCARD_SECOND_${bulk ? 'BULK' : 'SINGLE'}.txt`
        const filePath = path.join(repoPath, fileName)
        const otherPath = path.join(repoPath, otherFileName)
        const execute = host?.exec
        if (managed && !execute) {
          throw new Error('Missing Docker control')
        }
        if (execute) {
          execute(
            `printf 'COMMITTED_OWNER\n' > ${shellQuote(filePath)} && printf 'COMMITTED_SECOND\n' > ${shellQuote(otherPath)} && git -C ${shellQuote(repoPath)} add -- ${shellQuote(fileName)} ${shellQuote(otherFileName)} && git -C ${shellQuote(repoPath)} -c user.name=E2E -c user.email=e2e@example.invalid commit -qm 'Owned discard fixture' && printf 'CHANGED_ON_DISK\n' > ${shellQuote(filePath)} && printf 'CHANGED_SECOND\n' > ${shellQuote(otherPath)}`
          )
        } else {
          writeFileSync(filePath, 'COMMITTED_OWNER\n')
          writeFileSync(otherPath, 'COMMITTED_SECOND\n')
          execFileSync('git', ['-C', repoPath, 'add', '--', fileName, otherFileName])
          execFileSync('git', [
            '-C',
            repoPath,
            '-c',
            'user.name=E2E',
            '-c',
            'user.email=e2e@example.invalid',
            'commit',
            '-qm',
            'Owned discard fixture'
          ])
          writeFileSync(filePath, 'CHANGED_ON_DISK\n')
          writeFileSync(otherPath, 'CHANGED_SECOND\n')
        }
        const readDisk = (absolutePath: string): string =>
          execute
            ? execute(`cat ${shellQuote(absolutePath)}`)
            : readFileSync(absolutePath, 'utf8').trim()
        const first = await session.launch()
        app = first.app
        await waitForSessionReady(first.page)
        let page = first.page
        let worktreeId: string
        let runtimeEnvironmentId: string | null = null
        if (host) {
          await session.close(app)
          app = null
          const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
            repoPath,
            folderPath: host.remoteFolderPath
          })
          const launched = await session.launch()
          app = launched.app
          page = launched.page
          await waitForSessionReady(page)
          await convertAndRetain(page, session.userDataDir, seeded)
          const environment = (
            await page.evaluate(() => window.api.runtimeEnvironments.list())
          ).find((entry) => entry.orcadDeployment?.sshTargetId === seeded.targetId)
          if (!environment) {
            throw new Error('Missing managed environment')
          }
          runtimeEnvironmentId = environment.id
          worktreeId = seeded.worktreeId
        } else {
          const repoId = await page.evaluate(async (repoPath) => {
            const result = await window.api.repos.add({ path: repoPath })
            if ('error' in result) {
              throw new Error(result.error)
            }
            return result.repo.id
          }, repoPath)
          worktreeId = `${repoId}::${repoPath}`
        }
        await dismissTransientAnnouncement(page)
        const identity = getWorktreeHostIdentity({
          id: worktreeId,
          hostId: runtimeEnvironmentId ? toRuntimeExecutionHostId(runtimeEnvironmentId) : 'local'
        })
        await page.locator(`[data-worktree-host-identity="${identity}"]:visible`).click()
        await page.evaluate(
          async (target) => {
            const state = window.__store?.getState()
            if (!state) {
              throw new Error('Missing app store')
            }
            await state.updateSettings({ editorAutoSave: false, editorAutoSaveDelayMs: 1000 })
            state.openFile({
              filePath: target.filePath,
              relativePath: target.fileName,
              worktreeId: target.worktreeId,
              runtimeEnvironmentId: target.runtimeEnvironmentId,
              language: 'plaintext',
              mode: 'edit'
            })
            state.setRightSidebarOpen(true)
          },
          { filePath, fileName, worktreeId, runtimeEnvironmentId }
        )
        await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30_000 })
        await expect
          .poll(() => page.evaluate(() => window.__monacoEditorE2E?.snapshot().valueTail))
          .toContain('CHANGED_ON_DISK')
        await page.locator('.monaco-editor').click()
        await page.keyboard.press('ControlOrMeta+End')
        await page.keyboard.type('PENDING_EDITOR_DRAFT')
        await expect
          .poll(() =>
            page.evaluate(() => {
              const state = window.__store?.getState()
              return state?.activeFileId ? state.editorDrafts[state.activeFileId] : null
            })
          )
          .toContain('PENDING_EDITOR_DRAFT')
        await page.getByRole('button', { name: /Source Control/ }).click()
        const row = page.getByTestId('source-control-entry').filter({ hasText: fileName })
        await expect(row).toBeVisible()
        const discard = bulk
          ? page.getByRole('button', { name: 'Discard all', exact: true })
          : row.getByRole('button', { name: 'Discard changes', exact: true })
        await discard.focus()
        await discard.press('Enter')
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        await installEditorSaveIpcBarrier(app, {
          filePath,
          relativePath: fileName,
          runtimeEnvironmentId
        })
        await page.evaluate(async () => {
          window.addEventListener('orca:editor-quiesce-file-saves', (event) => {
            if (event instanceof CustomEvent) {
              console.log(
                '[actual-discard-quiesce-owner]',
                JSON.stringify({
                  target: event.detail,
                  focus: window.__store?.getState().settings?.activeRuntimeEnvironmentId
                })
              )
            }
          })
          await window.__store?.getState().updateSettings({ editorAutoSave: true })
        })
        page.on('console', (message) => {
          if (message.text().startsWith('[actual-discard-quiesce-owner]')) {
            console.log(message.text())
          }
        })
        await expect.poll(async () => (await readEditorSaveIpcBarrier(app!)).held).toBe(true)
        console.log('[actual-editor-save-pending-at-ipc]', true)
        await dialog
          .getByRole('button', { name: bulk ? 'Discard all' : 'Discard', exact: true })
          .click()
        await page.waitForTimeout(750)
        const beforeRelease = readDisk(filePath)
        console.log('[disk-before-save-release]', beforeRelease)
        await page.screenshot({ path: testInfo.outputPath('discard-before-save-release.png') })
        await releaseEditorSaveIpcBarrier(app)
        await expect.poll(async () => (await readEditorSaveIpcBarrier(app!)).completed).toBe(true)
        const receipt = await readEditorSaveIpcBarrier(app)
        expect(receipt.timedOut).toBe(false)
        console.log('[actual-save-response]', receipt.response)
        if (runtimeEnvironmentId) {
          expect(JSON.parse(receipt.response)).toMatchObject({ ok: true })
        } else {
          expect(receipt.response).toBe('undefined')
        }
        await page.waitForTimeout(750)
        console.log('[disk-after-save-and-discard]', readDisk(filePath))
        if (runtimeEnvironmentId) {
          console.log(
            '[positive-host-file-rpc]',
            await serverCall(page, runtimeEnvironmentId, 'files.read', {
              worktree: `id:${worktreeId}`,
              relativePath: fileName
            })
          )
        }
        console.log(
          '[rendered-editor-after-discard]',
          await page.evaluate(() => window.__monacoEditorE2E?.snapshot().valueTail)
        )
        await page.screenshot({ path: testInfo.outputPath('discard-final-editor.png') })
        expect(readDisk(filePath)).toBe('COMMITTED_OWNER')
        expect(beforeRelease).toBe('CHANGED_ON_DISK')
        expect(readDisk(otherPath)).toBe(bulk ? 'COMMITTED_SECOND' : 'CHANGED_SECOND')
      } finally {
        try {
          if (app) {
            await restoreEditorSaveIpcBarrier(app)
            await session.close(app)
          }
          await session.dispose()
        } finally {
          host?.cleanup()
        }
      }
    })
  }
}
