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
import { shellQuote } from './helpers/docker-ssh-relay-target'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import { getWorktreeHostIdentity } from '../../src/shared/worktree/host-qualified-identity'

const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
test.skip(!TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Needs Docker and server template')
test.skip(process.platform === 'win32', 'Owned SSH controls use POSIX paths')

test('a large managed status cannot offer an ignore write to a same-path desktop repo', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(4 * 60_000)
  const ignorePath = path.join(testRepoPath, '.gitignore')
  const localBefore = '# DESKTOP_IGNORE_OWNER\n'
  writeFileSync(ignorePath, localBefore)
  mkdirSync(path.join(testRepoPath, 'dist'), { recursive: true })
  const host = startOrcadConvertHost('docker', testInfo)
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE! })
  let app: ElectronApplication | null = null
  try {
    if (!host.exec) {
      throw new Error('Missing owned Docker controls')
    }
    const execute = host.exec
    execute(
      `mkdir -p ${shellQuote(path.dirname(testRepoPath))} && git clone --quiet ${shellQuote(host.remoteRepoPath)} ${shellQuote(testRepoPath)} && mkdir -p ${shellQuote(path.join(testRepoPath, 'node_modules'))} && i=0; while [ "$i" -lt 1010 ]; do printf x > ${shellQuote(path.join(testRepoPath, 'node_modules'))}/file-$i.txt; i=$((i+1)); done; printf '# REMOTE_IGNORE_OWNER\n' > ${shellQuote(ignorePath)}`
    )
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await first.page.evaluate(async (repoPath) => {
      const result = await window.api.repos.add({ path: repoPath })
      if ('error' in result) {
        throw new Error(result.error)
      }
    }, testRepoPath)
    expect(
      await first.page.evaluate(
        (worktreePath) => window.api.git.findHugeFoldersToIgnore({ worktreePath }),
        testRepoPath
      )
    ).toContain('dist')
    await session.close(app)
    app = null
    const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
      repoPath: testRepoPath,
      folderPath: host.remoteFolderPath
    })
    const launched = await session.launch()
    app = launched.app
    const page = launched.page
    await page.setViewportSize({ width: 1280, height: 1024 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        console.log('[renderer]', message.text())
      }
    })
    await waitForSessionReady(page)
    await convertAndRetain(page, session.userDataDir, seeded)
    const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
      (entry) => entry.orcadDeployment?.sshTargetId === seeded.targetId
    )
    if (!environment) {
      throw new Error('Missing managed environment')
    }
    const status = JSON.parse(
      await serverCall(page, environment.id, 'git.status', {
        worktree: `id:${seeded.worktreeId}`,
        includeLineStats: false
      })
    )
    console.log('[actual-managed-status-limit]', {
      didHitLimit: status.result?.didHitLimit,
      entries: status.result?.entries?.length,
      runtime: status._meta?.runtimeId
    })
    expect(status.result?.didHitLimit).toBe(true)
    await dismissTransientAnnouncement(page)
    const identity = getWorktreeHostIdentity({
      id: seeded.worktreeId,
      hostId: toRuntimeExecutionHostId(environment.id)
    })
    await page.locator(`[data-worktree-host-identity="${identity}"]:visible`).click()
    await page.evaluate(() => {
      const state = window.__store?.getState()
      state?.setRightSidebarTab('explorer')
      state?.setRightSidebarOpen(true)
    })
    await page.getByRole('button', { name: /Source Control/ }).click()
    await expect(page.getByRole('textbox', { name: 'Commit message' })).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(
          (id) => window.__store?.getState().gitStatusHugeByWorktree[id],
          seeded.worktreeId
        )
      )
      .toBeTruthy()
    const addIgnore = page.getByRole('button', { name: 'Add to .gitignore', exact: true })
    const offered = await addIgnore.waitFor({ state: 'visible', timeout: 3_000 }).then(
      () => true,
      () => false
    )
    if (offered) {
      await addIgnore.hover()
      await expect(
        page
          .locator('[data-sonner-toast]')
          .filter({ hasText: 'This repository has too many active changes' })
      ).toBeInViewport({ ratio: 1 })
    }
    await page.screenshot({ path: testInfo.outputPath('managed-huge-ignore-observed.png') })
    if (offered) {
      await addIgnore.click()
      await expect.poll(() => readFileSync(ignorePath, 'utf8')).toContain('dist/')
    }
    console.log('[desktop-ignore-after-remote-action]', readFileSync(ignorePath, 'utf8'))
    console.log('[remote-ignore-after-remote-action]', execute(`cat ${shellQuote(ignorePath)}`))
    expect(readFileSync(ignorePath, 'utf8')).toBe(localBefore)
    await expect(addIgnore).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('managed-huge-ignore-corrected.png') })
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

test('a large desktop status still offers and applies its local ignore suggestion', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(2 * 60_000)
  const ignorePath = path.join(testRepoPath, '.gitignore')
  writeFileSync(ignorePath, '# LOCAL_CONTROL\n')
  const folder = path.join(testRepoPath, 'dist')
  mkdirSync(folder, { recursive: true })
  for (let index = 0; index < 1010; index += 1) {
    writeFileSync(path.join(folder, `local-${index}.txt`), 'local control\n')
  }
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  try {
    const launched = await session.launch()
    app = launched.app
    const page = launched.page
    await page.setViewportSize({ width: 1280, height: 1024 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForSessionReady(page)
    const repoId = await page.evaluate(async (repoPath) => {
      const result = await window.api.repos.add({ path: repoPath })
      if ('error' in result) {
        throw new Error(result.error)
      }
      return result.repo.id
    }, testRepoPath)
    await expect.poll(() => page.locator('[data-worktree-id]').count()).toBeGreaterThan(0)
    await page.locator(`[data-worktree-id="${repoId}::${testRepoPath}"]:visible`).click()
    await page.evaluate(() => {
      const state = window.__store?.getState()
      state?.setRightSidebarTab('explorer')
      state?.setRightSidebarOpen(true)
    })
    await dismissTransientAnnouncement(page)
    await page.getByRole('button', { name: /Source Control/ }).click()
    const addIgnore = page.getByRole('button', { name: 'Add to .gitignore', exact: true })
    await expect(addIgnore).toBeVisible({ timeout: 15_000 })
    await addIgnore.hover()
    await expect(
      page
        .locator('[data-sonner-toast]')
        .filter({ hasText: 'This repository has too many active changes' })
    ).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: testInfo.outputPath('desktop-huge-ignore-control-before.png') })
    await addIgnore.click()
    await expect.poll(() => readFileSync(ignorePath, 'utf8')).toContain('dist/')
    console.log('[desktop-ignore-control-written]', readFileSync(ignorePath, 'utf8'))
    await page.screenshot({ path: testInfo.outputPath('desktop-huge-ignore-control-after.png') })
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})
