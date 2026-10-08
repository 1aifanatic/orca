/** A forced managed-server update refreshes SSH Settings and preserves the existing terminal. */
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import { managedServer, reconnect, serverCall } from './helpers/orcad-convert-flow'
import {
  isOrcadFullVersion,
  makeOrcadTemplateVariant,
  readHostOrcadActivation
} from './helpers/orcad-template-variant'
import { ORCAD_CONVERT_HOST_ENV, startOrcadConvertHost } from './helpers/orcad-convert-host'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'

const HOST = process.env[ORCAD_CONVERT_HOST_ENV]
const TEMPLATE_SOURCE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
const SCRATCH = path.join(os.tmpdir(), `orca-orcad-manual-update-${process.pid}`)
const TEMPLATE_DIR = path.join(SCRATCH, 'orcad-template')

test.skip(
  HOST !== 'docker' || !TEMPLATE_SOURCE,
  `Set ${ORCAD_CONVERT_HOST_ENV}=docker and ORCA_E2E_ORCAD_CONVERT_TEMPLATE`
)

test('a manual update clears deferred SSH status and preserves its live terminal', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.skip(HOST !== 'docker', 'Reads the activation record through the Docker host')
  test.setTimeout(20 * 60_000)
  mkdirSync(SCRATCH, { recursive: true })
  cpSync(TEMPLATE_SOURCE!, TEMPLATE_DIR, { recursive: true })
  const host = startOrcadConvertHost('docker', testInfo)
  const session = createRestartSession(testInfo, {
    ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_DIR
  })
  let app: ElectronApplication | null = null
  try {
    // Template A: the empty host deploys managed orcad on its first connect.
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    const targetId = await first.page.evaluate(async (input) => {
      const { target } = await window.api.ssh.addTarget({ target: input })
      return target.id
    }, host.input)
    await reconnect(first.page, targetId, { disconnectFirst: false })
    await expect
      .poll(() => managedServer(first.page, targetId), { timeout: 8 * 60_000 })
      .toMatchObject({ kind: 'managed' })
    const deployed = readHostOrcadActivation(host.exec!)
    expect(isOrcadFullVersion(deployed.active)).toBe(true)
    if (!host.exec) {
      throw new Error('Missing owned Docker controls')
    }
    const initialManaged = await managedServer(first.page, targetId)
    if (
      typeof initialManaged !== 'object' ||
      initialManaged === null ||
      !('environmentId' in initialManaged) ||
      typeof initialManaged.environmentId !== 'string'
    ) {
      throw new Error('Missing managed environment')
    }
    const environmentId = initialManaged.environmentId
    await serverCall(first.page, environmentId, 'repo.add', { path: host.remoteRepoPath })
    const created = JSON.parse(
      await serverCall(first.page, environmentId, 'terminal.create', {
        worktree: `path:${host.remoteRepoPath}`,
        command:
          'printf "%s\\n" "$$" > /tmp/orca-live-update.pid; printf "FORCE_BEFORE_UPDATE\\n"; exec sleep 42624'
      })
    )
    expect(created.result?.terminal?.handle).toEqual(expect.any(String))
    const terminalHandle = created.result.terminal.handle
    await expect
      .poll(() => host.exec?.('cat /tmp/orca-live-update.pid 2>/dev/null || true').trim())
      .toMatch(/^[1-9]\d*$/)
    const terminalPid = Number(host.exec('cat /tmp/orca-live-update.pid').trim())
    expect(Number.isSafeInteger(terminalPid)).toBe(true)
    expect(host.exec(`kill -0 ${terminalPid} && printf live`).trim()).toBe('live')
    console.log('[live-update-terminal]', { environmentId, terminalHandle, terminalPid })
    await expect
      .poll(async () => {
        const reply = JSON.parse(
          await serverCall(first.page, environmentId, 'terminal.read', {
            terminal: terminalHandle
          })
        )
        console.log('[before-update-terminal-read]', reply)
        return reply.result?.terminal?.tail
      })
      .toContain('FORCE_BEFORE_UPDATE')
    await session.close(app)
    app = null

    // Live terminals keep template B deferred until a manual update.
    makeOrcadTemplateVariant(TEMPLATE_DIR, 'B')
    const updated = await session.launch({
      onStderr: (chunk) => {
        if (chunk.includes('[ssh]')) {
          process.stderr.write(chunk)
        }
      }
    })
    app = updated.app
    await waitForSessionReady(updated.page)
    // A disconnect here cancels the launch-time update check.
    console.log(
      '[live-update-connect]',
      await reconnect(updated.page, targetId, { disconnectFirst: false })
    )
    await expect
      .poll(() => managedServer(updated.page, targetId), { timeout: 60_000 })
      .toMatchObject({ kind: 'managed', environmentId, update: { state: 'deferred' } })
    expect(readHostOrcadActivation(host.exec!).active).toBe(deployed.active)
    expect(host.exec!(`kill -0 ${terminalPid} && printf live`).trim()).toBe('live')
    console.log(
      '[live-update-positive-list]',
      await serverCall(updated.page, environmentId, 'terminal.list')
    )
    await updated.page.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsTarget({ pane: 'ssh', repoId: null })
      state?.openSettingsPage()
    })
    await expect(updated.page.getByPlaceholder('Search settings')).toBeVisible()
    await dismissTransientAnnouncement(updated.page)
    await expect(
      updated.page.getByText('Runs a managed Orca server; it updates on a later connect.', {
        exact: true
      })
    ).toBeVisible()
    await updated.page.screenshot({
      path: testInfo.outputPath('managed-update-settings-deferred.png')
    })
    const forced = await updated.page.evaluate(async (id) => {
      const api = window.api.runtimeEnvironments.managedOrcad
      if (!api) {
        throw new Error('Missing managed server API')
      }
      return api.update({ selector: id, force: true })
    }, environmentId)
    console.log('[forced-live-update]', forced)
    expect(forced.outcome).toBe('updated')
    expect(readHostOrcadActivation(host.exec!).active).not.toBe(deployed.active)
    expect(host.exec!(`kill -0 ${terminalPid} && printf live`).trim()).toBe('live')
    console.log(
      '[forced-live-update-positive-list]',
      await serverCall(updated.page, environmentId, 'terminal.list')
    )
    await expect
      .poll(
        async () => {
          const reply = JSON.parse(
            await serverCall(updated.page, environmentId, 'terminal.read', {
              terminal: terminalHandle
            })
          )
          console.log('[after-forced-update-terminal-read]', reply)
          return reply.result?.terminal?.tail
        },
        { timeout: 15_000 }
      )
      .toContain('FORCE_BEFORE_UPDATE')
    console.log(
      '[manual-update-status-after-positive-rpc]',
      JSON.stringify(await managedServer(updated.page, targetId))
    )
    const currentStatus = await updated.page.evaluate(async (id) => {
      const api = window.api.runtimeEnvironments.managedOrcad
      if (!api) {
        throw new Error('Missing managed server API')
      }
      return api.getStatus({ selector: id })
    }, environmentId)
    console.log('[manual-update-runtime-status]', JSON.stringify(currentStatus))
    expect(currentStatus.activeVersion).toBe(forced.activeVersion)
    expect(currentStatus.deferredUpdate).toBeNull()
    expect(readHostOrcadActivation(host.exec!).active).toBe(forced.activeVersion)
    await updated.page.screenshot({
      path: testInfo.outputPath('managed-update-settings-observed.png')
    })
    await expect(
      updated.page.getByText('Runs a managed Orca server; it updates on a later connect.', {
        exact: true
      })
    ).toHaveCount(0, { timeout: 10_000 })
    await updated.page.screenshot({
      path: testInfo.outputPath('managed-update-settings-corrected.png')
    })
    await serverCall(updated.page, environmentId, 'terminal.close', { terminal: terminalHandle })
    await expect
      .poll(() =>
        host.exec!(`kill -0 ${terminalPid} 2>/dev/null && printf live || printf exited`).trim()
      )
      .toBe('exited')
    await expect
      .poll(() => managedServer(updated.page, targetId))
      .toEqual({
        kind: 'managed',
        environmentId
      })
    const record = readHostOrcadActivation(host.exec!)
    expect(isOrcadFullVersion(record.active)).toBe(true)
    expect(record.previous).toBe(deployed.active)
    expect(record.activeAppVersion).toBeTruthy()
  } finally {
    try {
      if (app) {
        await session.close(app)
      }
      await session.dispose()
    } finally {
      host.cleanup()
      rmSync(SCRATCH, { recursive: true, force: true })
    }
  }
})
