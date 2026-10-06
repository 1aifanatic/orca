import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { ORCAD_FENCE_LOST_EXIT, ORCAD_FENCE_LOST_MARKER } from './orcad-activation-fence-scope'
import { ORCAD_WINDOWS_HOST_SCRIPT } from './orcad-windows-host-script'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function hostWithFence(token: string) {
  const dir = mkdtempSync(join(tmpdir(), 'orcad-win-fence-'))
  dirs.push(dir)
  const script = join(dir, 'host.js')
  writeFileSync(script, ORCAD_WINDOWS_HOST_SCRIPT)
  const root = join(dir, '.orcad-activation-transaction')
  const lock = join(root, '.install-lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, '.orca-fence-owner'), token)
  const journal = join(root, 'transaction.json')
  writeFileSync(journal, '{}')
  const op = (...args: string[]) =>
    runProcess({ program: process.execPath, args: [script, ...args], timeoutMs: 15_000 })
  return { lock, journal, op }
}

// The Windows host script enforces the same generation check as the POSIX guard.
describe('the Windows host script under an activation fence', () => {
  it('runs an op only for the fence’s current holder', async () => {
    const host = hostWithFence('successor')
    const stale = await host.op('--fence', host.lock, 'stale', 'fence-check')
    expect(stale.code).toBe(ORCAD_FENCE_LOST_EXIT)
    expect(stale.stdout).toContain(ORCAD_FENCE_LOST_MARKER)
    const owner = await host.op('--fence', host.lock, 'successor', 'fence-check')
    expect(owner).toMatchObject({ code: 0, stdout: 'OK' })
  })

  it('releases only its own generation, leaving a successor’s fence and journal', async () => {
    const host = hostWithFence('successor')
    expect((await host.op('fence-release', host.lock, host.journal, 'stale')).stdout).toBe(
      'SUPERSEDED'
    )
    expect(existsSync(host.lock)).toBe(true)
    expect(existsSync(host.journal)).toBe(true)
    expect((await host.op('fence-release', host.lock, host.journal, 'successor')).stdout).toBe(
      'RELEASED'
    )
    expect(existsSync(host.lock)).toBe(false)
    expect(existsSync(host.journal)).toBe(false)
  })
})
