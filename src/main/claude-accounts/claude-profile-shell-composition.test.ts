import type * as ProfileRouting from '../../shared/claude-profile-routing'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const gate = vi.hoisted(() => ({ enabled: true }))
vi.mock('../../shared/claude-profile-routing', async (original) => ({
  ...(await original<typeof ProfileRouting>()),
  claudeProfileRoutingEnabled: () => gate.enabled
}))
const FISH = '/opt/homebrew/bin/fish'
const roots: string[] = []
afterEach(() => {
  gate.enabled = true
  vi.resetModules()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
function fishInit({ args }: { args: string[] | null }): string {
  const init = args?.[2]
  if (!init) {
    throw new Error('fish launch was not wrapped')
  }
  return init
}
async function composed(enabled: boolean) {
  gate.enabled = enabled
  vi.resetModules()
  const local = await import('../providers/local-pty-shell-ready')
  const daemon = await import('../daemon/shell-ready')
  const powershell = await import('../powershell-osc133-bootstrap')
  const localBash = await import('../providers/local-pty-shell-ready-bash-rcfile')
  const daemonBash = await import('../daemon/daemon-bash-shell-ready-rcfile')
  return {
    bash: [
      localBash.getBashShellReadyRcfileContent(),
      daemonBash.getDaemonBashShellReadyRcfileContent()
    ],
    fish: [
      fishInit(local.getShellLaunchConfig(FISH, ['ready'])),
      fishInit(daemon.getShellLaunchConfig(FISH, ['ready']))
    ],
    powershell: powershell.getPowerShellOsc133Bootstrap()
  }
}

it('keeps the composed fish and PowerShell startup text dormant with the gate off', async () => {
  const off = await composed(false)
  for (const text of [...off.fish, off.powershell]) {
    expect(text).not.toContain('claude')
  }
  for (const text of off.bash) {
    expect(text).not.toContain('ORCA_CLAUDE')
  }
  for (const text of (await composed(true)).bash) {
    expect(text).toContain('ORCA_CLAUDE_INJECTED_CONFIG_DIR')
  }
})

it('starts the PowerShell claude function on its own line after the codex fragment', async () => {
  const on = await composed(true)
  expect(on.powershell).toContain(
    'Remove-Variable orcaCodexCommand -ErrorAction SilentlyContinue\n$orcaClaudeCommand'
  )
})

it.skipIf(!existsSync(FISH))(
  'defines both the ready hook and the claude function from the composed fish init',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-fish-compose-'))
    roots.push(root)
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', 'claude'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(root, 'bin', 'claude'), 0o700)
    const on = await composed(true)
    for (const init of on.fish) {
      const result = spawnSync(
        '/usr/bin/env',
        [
          '-i',
          `HOME=${root}`,
          `PATH=${join(root, 'bin')}:/usr/bin:/bin`,
          `ORCA_CLAUDE_PROFILE_POINTER=${join(root, 'selected')}`,
          FISH,
          '--no-config',
          '-c',
          `${init}\nfunctions -q claude; and echo CLAUDE-FN\nfunctions -q __orca_shell_ready_marker; and echo READY-HOOK`
        ],
        { encoding: 'utf8' }
      )
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('CLAUDE-FN')
      expect(result.stdout).toContain('READY-HOOK')
    }
  }
)
