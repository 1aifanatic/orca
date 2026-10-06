/**
 * A state mutation can outlast the activation fence's stale window, so it keeps the fence
 * fresh while it runs. Run for real with a one-second beat and the real steal command.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import { RELAY_INSTALL_LOCK_NAME } from '../../shared/relay-install-lock-name'
import { ORCAD_ACTIVATION_TRANSACTION_DIRNAME } from './orcad-activation-transaction'
import { serializedStateMutationCommand } from './orcad-state-snapshot'
import { tryStealInstallLockCommand } from './ssh-relay-install-lock-commands'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')
const STALE_SECONDS = 3

async function sh(command: string): Promise<string> {
  return (await runProcess({ program: '/bin/sh', args: ['-c', command] })).stdout.trim()
}
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(process.platform === 'win32')(
  'the fence heartbeat of a running state mutation',
  () => {
    let base = ''
    let fence = ''

    beforeEach(async () => {
      base = mkdtempSync(join(tmpdir(), 'orcad-fence-beat-'))
      fence = join(base, ORCAD_ACTIVATION_TRANSACTION_DIRNAME, RELAY_INSTALL_LOCK_NAME)
      mkdirSync(fence, { recursive: true })
    })
    afterEach(() => {
      rmSync(base, { recursive: true, force: true })
    })

    const backdate = (): Promise<string> => sh(`touch -m -t 200001010000 '${fence}'`)
    const steal = (): Promise<string> => sh(tryStealInstallLockCommand(posix, fence, STALE_SECONDS))
    const age = (): number => Date.now() / 1000 - statSync(fence).mtimeMs / 1000

    it('is not stolen while a long mutation runs, and is once its holder dies', async () => {
      // Stands in for a restore that outlasts the stale window.
      const run = spawnProcess({
        program: '/bin/sh',
        args: ['-c', serializedStateMutationCommand(base, 'sleep 30', 1)]
      })
      try {
        const pidFile = join(base, 'orcad-state-mutation.lock', 'pid')
        await expect
          .poll(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim())
          .toBeTruthy()

        await backdate()
        await pause(2_500)
        expect(age()).toBeLessThan(STALE_SECONDS)
        expect(await steal()).toBe('BUSY')

        // The host process dies (OOM, reboot of the session): nothing refreshes the fence now.
        process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL')
        await pause(1_500)
        await backdate()
        await pause(2_500)
        expect(age()).toBeGreaterThan(STALE_SECONDS)
        expect(await steal()).toMatch(/OK$/u)
      } finally {
        run.kill('SIGKILL')
      }
    }, 20_000)

    it('stops refreshing once the mutation finishes, and never creates a missing fence', async () => {
      await sh(serializedStateMutationCommand(base, 'sleep 2', 1))
      await backdate()
      await pause(2_500)
      expect(age()).toBeGreaterThan(STALE_SECONDS)

      rmSync(fence, { recursive: true })
      await sh(serializedStateMutationCommand(base, 'sleep 2', 1))
      expect(existsSync(fence)).toBe(false)
    }, 20_000)
  }
)
