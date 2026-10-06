import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as DeployHelpers from './ssh-relay-deploy-helpers'

// Every remote command runs in a real local shell, so the host-side checks are the real ones.
vi.mock('./ssh-relay-deploy-helpers', async (importOriginal) => {
  const { runProcess } = await import('../../shared/child-process/run-process')
  const { sshCommandExitError } = await import('./ssh-relay-exec-command')
  return {
    ...(await importOriginal<typeof DeployHelpers>()),
    execCommand: async (_conn: unknown, command: string) => {
      const result = await runProcess({ program: '/bin/sh', args: ['-c', command] })
      if (result.code !== 0) {
        throw sshCommandExitError(command, result.code ?? 1, result.stdout)
      }
      return result.stdout
    }
  }
})

const { orcadActivationFenceRefusal } = await import('./orcad-activation-fence-hold')
const { initOrcadHeldFenceTokenFile, ORCAD_HELD_FENCE_TOKENS_FILE_NAME } =
  await import('./orcad-held-fence-tokens')
const { getRemoteHostPlatform } = await import('./ssh-remote-platform')

// Above every Linux and macOS pid_max, so no process can hold it.
const EXITED_PID = 4_194_304 + 1
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

/** A fence quiet for ten minutes, owned by `owner`, with this desktop holding `held`. */
function hostWithFence(owner: string, held: { token: string; pid: number }[]) {
  const home = mkdtempSync(join(tmpdir(), 'orcad-exited-fence-'))
  homes.push(home)
  const fence = join(home, '.orca-remote', '.orcad-activation-transaction', '.install-lock')
  mkdirSync(fence, { recursive: true })
  writeFileSync(join(fence, '.orca-fence-owner'), owner)
  const quietSince = new Date(Date.now() - 10 * 60_000)
  utimesSync(fence, quietSince, quietSince)
  mkdirSync(join(home, 'data'))
  initOrcadHeldFenceTokenFile(join(home, 'data', 'orca-data.json'))
  const store = join(home, 'data', ORCAD_HELD_FENCE_TOKENS_FILE_NAME)
  writeFileSync(store, JSON.stringify(held))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked to a local shell, so the connection is never used.
  const options = { conn: {} as never, host: getRemoteHostPlatform('linux-x64'), remoteHome: home }
  return { home, fence, store, options }
}

// BUG-23: a quit mid-update left this desktop's own fence, and the next launch waited 20 minutes.
describe.skipIf(process.platform === 'win32')('a fence this desktop’s exited process left', () => {
  it('is cleared at once when quiet and no state mutation is live', async () => {
    const { fence, store, options } = hostWithFence('t-exited', [
      { token: 't-exited', pid: EXITED_PID }
    ])
    await expect(orcadActivationFenceRefusal(options, 'update')).resolves.toMatchObject({
      cleared: true
    })
    expect(existsSync(fence)).toBe(false)
    expect(readFileSync(store, 'utf-8')).not.toContain('t-exited')
  })

  it('is kept while a state mutation of that run may still be running', async () => {
    const { home, fence, options } = hostWithFence('t-exited', [
      { token: 't-exited', pid: EXITED_PID }
    ])
    // sshd kept the pty-less restore running after the desktop quit.
    const mutation = join(home, '.orca-remote', 'orcad-state-mutation.lock')
    mkdirSync(mutation)
    writeFileSync(join(mutation, 'pid'), String(process.pid))
    const refusal = await orcadActivationFenceRefusal(options, 'update')
    expect(refusal.cleared).toBeUndefined()
    expect(refusal.code).toBe('orcad_activation_fence_busy')
    expect(existsSync(fence)).toBe(true)
  })

  it('is kept while it is not yet quiet', async () => {
    const { fence, options } = hostWithFence('t-exited', [{ token: 't-exited', pid: EXITED_PID }])
    utimesSync(fence, new Date(), new Date())
    expect((await orcadActivationFenceRefusal(options, 'update')).cleared).toBeUndefined()
    expect(existsSync(fence)).toBe(true)
  })

  it('never touches a fence another desktop holds', async () => {
    const { fence, options } = hostWithFence('t-foreign', [{ token: 't-ours', pid: EXITED_PID }])
    const refusal = await orcadActivationFenceRefusal(options, 'update')
    expect(refusal.cleared).toBeUndefined()
    expect(refusal.code).toBe('orcad_activation_fence_busy')
    expect(existsSync(fence)).toBe(true)
  })

  it('never touches a fence a live process of this desktop holds', async () => {
    const { fence, options } = hostWithFence('t-live', [{ token: 't-live', pid: process.pid }])
    expect((await orcadActivationFenceRefusal(options, 'update')).cleared).toBeUndefined()
    expect(existsSync(fence)).toBe(true)
  })
})
