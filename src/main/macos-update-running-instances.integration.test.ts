import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { spawnProcess } from '../shared/child-process/run-process'
import { getMacUpdateRunningInstances } from './macos-update-running-instances'

it.runIf(process.platform === 'darwin')(
  'detects real sibling processes with spaces in the bundle path and clears after they exit',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-update-instances-'))
    const executable = path.join(root, 'Orca Test.app', 'Contents', 'MacOS', 'Orca Test')
    mkdirSync(path.dirname(executable), { recursive: true })
    copyFileSync('/bin/sleep', executable)
    const self = spawnProcess({ program: executable, args: ['30'] })
    const sibling = spawnProcess({ program: executable, args: ['30'] })
    const selfClosed = once(self, 'close')
    const siblingClosed = once(sibling, 'close')
    try {
      expect(self.pid).toBeTypeOf('number')
      expect(sibling.pid).toBeTypeOf('number')
      await vi.waitFor(async () => {
        expect(await getMacUpdateRunningInstances(executable, self.pid)).toEqual([sibling.pid])
      })
      sibling.kill('SIGTERM')
      await siblingClosed
      expect(await getMacUpdateRunningInstances(executable, self.pid)).toEqual([])
    } finally {
      self.kill('SIGTERM')
      sibling.kill('SIGTERM')
      await Promise.all([selfClosed, siblingClosed])
      rmSync(root, { recursive: true, force: true })
    }
  }
)
