import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as DeployHelpers from './ssh-relay-deploy-helpers'

// Every remote command runs in a real local shell, so the host-side checks are the real ones.
vi.mock('./ssh-relay-deploy-helpers', async (importOriginal) => {
  const { runProcess } = await import('../../shared/child-process/run-process')
  return {
    ...(await importOriginal<typeof DeployHelpers>()),
    execCommand: async (_conn: unknown, command: string) => {
      const result = await runProcess({ program: '/bin/sh', args: ['-c', command] })
      if (result.code !== 0) {
        throw new Error(`failed (exit ${result.code}): ${result.stdout}`)
      }
      return result.stdout
    }
  }
})

const { withOrcadActivationLock } = await import('./orcad-activation-lock')
const { orcadActivationFenceRefusal } = await import('./orcad-activation-fence-hold')
const { execOrcadRemote } = await import('./orcad-remote-runtime-control')
const { OrcadFenceLostError } = await import('./orcad-activation-fence-scope')
const { getRemoteHostPlatform } = await import('./ssh-remote-platform')

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

// Astra pass 8: a holder suspended past the stale window resumed, kept acting, and its release
// deleted the successor's fence and recovery journal mid-update.
describe.skipIf(process.platform === 'win32')('a superseded activation fence holder', () => {
  it('can neither act nor release once a successor took its fence over', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orcad-fence-gen-'))
    homes.push(home)
    const root = join(home, '.orca-remote', '.orcad-activation-transaction')
    const fence = join(root, '.install-lock')
    const journal = join(root, 'transaction.json')
    const launched = join(home, 'launched-by-stale-holder')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked to a local shell, so the connection is never used.
    const conn = {} as never
    const options = { conn, host: getRemoteHostPlatform('linux-x64'), remoteHome: home }

    let resumeStale!: () => void
    let staleEntered = false
    const stale = withOrcadActivationLock(
      options,
      async () => {
        staleEntered = true
        await new Promise<void>((resolve) => (resumeStale = resolve))
        // Resumed: it still believes it holds the fence and tries to start its slot.
        await execOrcadRemote(options, `touch '${launched}'`)
        return 'acted'
      },
      () => 'held'
    )
    await vi.waitFor(() => expect(staleEntered).toBe(true))
    // Suspended past the stale window: nothing refreshes its fence.
    utimesSync(fence, new Date(0), new Date(0))
    expect(await orcadActivationFenceRefusal(options, 'update')).toMatchObject({ cleared: true })

    let resumeSuccessor!: () => void
    let successorEntered = false
    const successor = withOrcadActivationLock(
      options,
      async () => {
        writeFileSync(journal, '{"successor":"mid-update"}')
        successorEntered = true
        await new Promise<void>((resolve) => (resumeSuccessor = resolve))
        return 'done'
      },
      () => 'held'
    )
    await vi.waitFor(() => expect(successorEntered).toBe(true))

    resumeStale()
    await expect(stale).rejects.toBeInstanceOf(OrcadFenceLostError)
    expect(existsSync(launched)).toBe(false)
    // The successor's fence and journal survive the stale holder's release.
    expect(existsSync(fence)).toBe(true)
    expect(existsSync(journal)).toBe(true)

    resumeSuccessor()
    expect(await successor).toBe('done')
    expect(existsSync(fence)).toBe(false)
    expect(existsSync(journal)).toBe(false)
  })
})
