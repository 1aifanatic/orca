import { describe, test, expect } from 'bun:test'
import { join } from 'node:path'
import { runWindowsNativeIoFailure } from './native-io-failure-fixture.cjs'
describe('real Windows native I/O isolation', () => {
  for (const operation of ['write-close', 'late-write', 'drain-close']) {
    test(operation, async () => {
      const report = await runWindowsNativeIoFailure({operation, workerPath:join(import.meta.dir,'windows-bun-pty-gate-entry.js')})
      console.log(JSON.stringify({operation,...report}))
      expect(report.victimExitCount).toBe(1)
      expect(report.witnessExitCount).toBe(0)
      expect(report.uncaught).toEqual([])
      if(operation==='write-close') expect(report.nativeFailure).toBe('Terminal is closed')
      if(operation==='drain-close') {
        expect(report.exitCode).toBe(17)
        expect(report.finalOutputBeforeExit).toBe(true)
      }
    }, 65000)
  }
})
