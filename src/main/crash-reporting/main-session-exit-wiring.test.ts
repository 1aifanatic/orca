import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the call sites that mark a main-process exit as clean or unclean.
 * Source-level because these run inside startup/quit composition with no runtime
 * seam; dropping one leaves every marker unit test green while each normal quit
 * reads as a crash (or a crash as a clean exit) on the next launch.
 */
// Why normalize: nothing pins src/**/*.ts to LF, so a CRLF checkout would fail spuriously.
const readSource = (relativePath: string): string =>
  readFileSync(join(process.cwd(), 'src/main', relativePath), 'utf8').replace(/\r\n/g, '\n')

function bodyAfter(source: string, anchor: string): string {
  const start = source.indexOf(anchor)
  expect(start).toBeGreaterThanOrEqual(0)
  return source
    .slice(start + anchor.length)
    .split('\nfunction ')[0]
    .split('\nexport ')[0]
}

describe('main session exit record wiring', () => {
  it('records the will-quit exit only after teardown settles and before app.quit()', () => {
    const body = bodyAfter(readSource('startup/main-process-quit.ts'), "app.on('will-quit'")
    const recordCall = "recordMainSessionExit(updateQuitInProgress ? 'update-install' : 'quit')"
    expect(body.split(recordCall).length - 1).toBe(1)
    const recordAt = body.indexOf(recordCall)
    // Why after teardown: a native crash while tearing down must still read as unclean.
    expect(recordAt).toBeGreaterThan(body.indexOf('settleTeardownWithinDeadline(['))
    expect(recordAt).toBeGreaterThan(body.indexOf('shutdownObservability()'))
    expect(recordAt).toBeLessThan(body.lastIndexOf('app.quit()'))
  })

  it('installs the OS shutdown record during observer startup', () => {
    const body = bodyAfter(
      readSource('startup/main-process-observers.ts'),
      'export function initializeMainProcessObservers('
    )
    expect(body).toContain('\n  installOsShutdownExitRecord(powerMonitor, process.platform)')
  })

  it('revokes a provisional exit when the main window aborts a quit', () => {
    const source = readSource('startup/main-window-controller.ts')
    const abortHandler = source.slice(source.indexOf('onQuitAborted: () => {')).split('\n    },')[0]
    expect(abortHandler).toContain('revokeProvisionalMainSessionExit()')
  })
})
