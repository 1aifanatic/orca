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

const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
test.skip(!TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Needs owned Docker host')
test.skip(process.platform === 'win32', 'Owned POSIX fixture')

test('deleting a managed file preserves a dirty desktop editor at the same path', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(4 * 60_000)
  const fileName = 'DELETE_EDITOR_OWNER.txt'
  const filePath = path.join(testRepoPath, fileName)
  const localBefore = 'DESKTOP_DELETE_EDITOR_OWNER\n'
  writeFileSync(filePath, localBefore)
  const intermediate = path.join(testRepoPath, 'intermediate-owned-repo')
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
      `mkdir -p ${shellQuote(path.dirname(testRepoPath))} && git clone --quiet ${shellQuote(host.remoteRepoPath)} ${shellQuote(testRepoPath)} && printf 'REMOTE_DELETE_EDITOR_OWNER\n' > ${shellQuote(filePath)}`
    )
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    const localRepos = await first.page.evaluate(
      async (paths) => {
        const ids: string[] = []
        for (const repoPath of paths) {
          const result = await window.api.repos.add({ path: repoPath })
          if ('error' in result) {
            throw new Error(result.error)
          }
          ids.push(`${result.repo.id}::${repoPath}`)
        }
        return ids
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
    if (!environment || !localRepos[0] || !localRepos[1]) {
      throw new Error('Missing owned workspace')
    }
    await dismissTransientAnnouncement(page)
    const desktopIdentity = getWorktreeHostIdentity({ id: localRepos[0], hostId: 'local' })
    await page.locator(`[data-worktree-host-identity="${desktopIdentity}"]:visible`).click()
    await openFileExplorer(page)
    await expect(
      page.locator('[data-file-explorer-row]').filter({ hasText: fileName })
    ).toBeVisible()
    await page.evaluate(
      async (target) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Missing store')
        }
        await state.updateSettings({ editorAutoSave: false })
        state.openFile({
          filePath: target.filePath,
          relativePath: target.fileName,
          worktreeId: target.worktreeId,
          runtimeEnvironmentId: null,
          language: 'plaintext',
          mode: 'edit'
        })
      },
      { filePath, fileName, worktreeId: localRepos[0] }
    )
    await expect
      .poll(() => page.evaluate(() => window.__monacoEditorE2E?.snapshot().valueTail))
      .toBe('DESKTOP_DELETE_EDITOR_OWNER')
    await page.locator('.monaco-editor').click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('PENDING_DESKTOP_DELETE_DRAFT')
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = window.__store?.getState()
          return state?.activeFileId ? state.editorDrafts[state.activeFileId] : null
        })
      )
      .toContain('PENDING_DESKTOP_DELETE_DRAFT')
    const middleIdentity = getWorktreeHostIdentity({ id: localRepos[1], hostId: 'local' })
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
      '[actual-remote-delete-file]',
      await serverCall(page, environment.id, 'files.read', {
        worktree: `id:${seeded.worktreeId}`,
        relativePath: fileName
      })
    )
    console.log(
      '[open-editor-owners-before-delete]',
      await page.evaluate(() =>
        window.__store?.getState().openFiles.map((file) => ({
          id: file.id,
          filePath: file.filePath,
          worktreeId: file.worktreeId,
          runtimeEnvironmentId: file.runtimeEnvironmentId,
          isDirty: file.isDirty
        }))
      )
    )
    console.log('[desktop-disk-before-delete]', readFileSync(filePath, 'utf8'))
    expect(readFileSync(filePath, 'utf8')).toBe(localBefore)
    await remoteRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^Delete/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('foreign-editor-delete-confirm.png') })
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect
      .poll(() =>
        execute(`if test -e ${shellQuote(filePath)}; then printf exists; else printf deleted; fi`)
      )
      .toBe('deleted')
    console.log('[actual-desktop-content-after-remote-delete]', readFileSync(filePath, 'utf8'))
    console.log(
      '[open-editors-after-delete]',
      await page.evaluate(() =>
        window.__store?.getState().openFiles.map((file) => ({
          id: file.id,
          worktreeId: file.worktreeId,
          isDirty: file.isDirty
        }))
      )
    )
    await page.locator(`[data-worktree-host-identity="${desktopIdentity}"]:visible`).click()
    await page.screenshot({ path: testInfo.outputPath('desktop-editor-after-remote-delete.png') })
    expect(readFileSync(filePath, 'utf8')).toBe(localBefore)
    const retained = await page.evaluate(
      (target) =>
        window.__store
          ?.getState()
          .openFiles.some(
            (file) =>
              file.filePath === target.filePath &&
              file.worktreeId === target.worktreeId &&
              file.isDirty
          ),
      { filePath, worktreeId: localRepos[0] }
    )
    expect(retained).toBe(true)
  } finally {
    try {
      if (app) {
        await session.close(app)
      }
      await session.dispose()
    } finally {
      host.cleanup()
    }
  }
})

test('deleting and undoing an owned managed file preserves its dirty draft', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(4 * 60_000)
  const host = startOrcadConvertHost('docker', testInfo)
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE! })
  let app: ElectronApplication | null = null
  try {
    if (!host.exec) {
      throw new Error('Missing owned host control')
    }
    const execute = host.exec
    const fileName = `DELETE_OWNED_DRAFT_${path.basename(testRepoPath)}.txt`
    const filePath = path.join(host.remoteRepoPath, fileName)
    execute(`printf 'MANAGED_OWNED_DRAFT\n' > ${shellQuote(filePath)}`)
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await session.close(app)
    app = null
    const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
      repoPath: host.remoteRepoPath,
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
    if (!environment) {
      throw new Error('Missing managed owner')
    }
    await dismissTransientAnnouncement(page)
    const identity = getWorktreeHostIdentity({
      id: seeded.worktreeId,
      hostId: toRuntimeExecutionHostId(environment.id)
    })
    await page.locator(`[data-worktree-host-identity="${identity}"]:visible`).click()
    await openFileExplorer(page)
    await page.evaluate(
      async (target) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Missing store')
        }
        await state.updateSettings({ editorAutoSave: false })
        state.openFile({
          filePath: target.filePath,
          relativePath: target.fileName,
          worktreeId: target.worktreeId,
          runtimeEnvironmentId: target.runtimeEnvironmentId,
          language: 'plaintext',
          mode: 'edit'
        })
      },
      { filePath, fileName, worktreeId: seeded.worktreeId, runtimeEnvironmentId: environment.id }
    )
    await expect
      .poll(() => page.evaluate(() => window.__monacoEditorE2E?.snapshot().valueTail))
      .toBe('MANAGED_OWNED_DRAFT')
    await page.locator('.monaco-editor').click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('PENDING_MANAGED_DELETE_DRAFT')
    const row = page.locator('[data-file-explorer-row]').filter({ hasText: fileName })
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^Delete/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect
      .poll(() =>
        execute(`if test -e ${shellQuote(filePath)}; then printf exists; else printf deleted; fi`)
      )
      .toBe('deleted')
    await expect
      .poll(() =>
        page.evaluate(
          (target) =>
            window.__store
              ?.getState()
              .openFiles.some(
                (file) => file.worktreeId === target.worktreeId && file.filePath === target.filePath
              ),
          { worktreeId: seeded.worktreeId, filePath }
        )
      )
      .toBe(false)
    const remainingRow = page.locator('[data-file-explorer-row]').filter({ hasText: /^README\.md/ })
    await remainingRow.focus()
    await remainingRow.press('ControlOrMeta+z')
    await expect
      .poll(() => execute(`cat ${shellQuote(filePath)} 2>/dev/null || true`))
      .toBe('MANAGED_OWNED_DRAFT\nPENDING_MANAGED_DELETE_DRAFT')
    console.log(
      '[actual-owned-delete-undo-draft]',
      await serverCall(page, environment.id, 'files.read', {
        worktree: `id:${seeded.worktreeId}`,
        relativePath: fileName
      })
    )
    await page.locator('[data-file-explorer-row]').filter({ hasText: fileName }).dblclick()
    await expect
      .poll(() => page.evaluate(() => window.__monacoEditorE2E?.snapshot().valueTail))
      .toBe('PENDING_MANAGED_DELETE_DRAFT')
    await page.keyboard.press('Escape')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText(
      'PENDING_MANAGED_DELETE_DRAFT'
    )
    await page.screenshot({ path: testInfo.outputPath('managed-owned-delete-undo-control.png') })
  } finally {
    try {
      if (app) {
        await session.close(app)
      }
      await session.dispose()
    } finally {
      host.cleanup()
    }
  }
})
