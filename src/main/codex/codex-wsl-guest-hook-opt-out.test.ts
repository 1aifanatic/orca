import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHookTrustEntries } from './config-toml-trust'
import { _internals, type CodexWslRuntimeHookInstallPlan } from './hook-service'
import { withdrawWslGuestCodexHooksForOptOut } from './codex-wsl-guest-hook-opt-out'

type HooksConfig = { hooks: Record<string, { hooks?: { command?: string }[] }[]> }

const USER_COMMAND = '/bin/sh /home/alice/user-hook.sh'
let tempRoots: string[] = []

beforeEach(() => {
  // Why: the trust-grant ledger lives in Orca's userData, which otherwise resolves to the live one.
  const userData = mkdtempSync(join(tmpdir(), 'orca-codex-wsl-opt-out-userdata-'))
  tempRoots.push(userData)
  vi.stubEnv('ORCA_USER_DATA_PATH', userData)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
  tempRoots = []
})

/** A stand-in for one running distro's own ~/.codex. */
function createGuestCodexHome(): CodexWslRuntimeHookInstallPlan {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-wsl-guest-home-'))
  tempRoots.push(root)
  const linuxHome = '/home/alice/.codex'
  return {
    configPath: join(root, 'hooks.json'),
    tomlPath: join(root, 'config.toml'),
    scriptPath: join(root, '.orca', 'agent-hooks', 'codex-hook.sh'),
    commandScriptPath: `${linuxHome}/.orca/agent-hooks/codex-hook.sh`,
    trustConfigPath: `${linuxHome}/hooks.json`,
    wslDistro: 'Ubuntu',
    linuxRuntimeHome: linuxHome
  }
}

function writeUserHooks(plan: CodexWslRuntimeHookInstallPlan): void {
  writeFileSync(
    plan.configPath,
    `${JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: USER_COMMAND }] }] }
    })}\n`,
    'utf-8'
  )
}

function commands(plan: CodexWslRuntimeHookInstallPlan): string[] {
  const config: HooksConfig = JSON.parse(readFileSync(plan.configPath, 'utf-8'))
  return Object.values(config.hooks).flatMap((definitions) =>
    definitions.flatMap((definition) => (definition.hooks ?? []).map((hook) => hook.command ?? ''))
  )
}

function orcaTrustKeys(plan: CodexWslRuntimeHookInstallPlan): string[] {
  return [...readHookTrustEntries(plan.tomlPath).keys()].filter((key) =>
    key.startsWith(plan.trustConfigPath)
  )
}

describe("Codex hooks opt-out in a WSL guest's own ~/.codex", () => {
  it("removes Orca's entries and trust and keeps the user's hooks", async () => {
    const guest = createGuestCodexHome()
    writeUserHooks(guest)
    expect((await _internals.installManagedHooksIntoWslRuntime(guest)).state).toBe('installed')
    expect(commands(guest).some((command) => command.includes('codex-hook.sh'))).toBe(true)

    await withdrawWslGuestCodexHooksForOptOut(async () => [guest])

    expect(commands(guest)).toEqual([USER_COMMAND])
    expect(orcaTrustKeys(guest)).toEqual([])
  })

  it('is restored by another Orca with hooks on at its next WSL launch', async () => {
    const guest = createGuestCodexHome()
    writeUserHooks(guest)
    await _internals.installManagedHooksIntoWslRuntime(guest)
    const installedCommands = commands(guest)
    const installedTrust = orcaTrustKeys(guest)
    await withdrawWslGuestCodexHooksForOptOut(async () => [guest])

    // Hooks-on launch prep for a WSL home runs this same install on every pane spawn.
    expect((await _internals.installManagedHooksIntoWslRuntime(guest)).state).toBe('installed')

    expect(commands(guest)).toEqual(installedCommands)
    expect(orcaTrustKeys(guest)).toEqual(installedTrust)
  })

  it('leaves a guest that holds no Orca entry exactly as it was', async () => {
    const withoutCodexConfig = createGuestCodexHome()
    const withUserHooksOnly = createGuestCodexHome()
    writeUserHooks(withUserHooksOnly)
    const before = readFileSync(withUserHooksOnly.configPath, 'utf-8')

    await withdrawWslGuestCodexHooksForOptOut(async () => [withoutCodexConfig, withUserHooksOnly])

    expect(existsSync(withoutCodexConfig.configPath)).toBe(false)
    expect(existsSync(withoutCodexConfig.tomlPath)).toBe(false)
    expect(readFileSync(withUserHooksOnly.configPath, 'utf-8')).toBe(before)
    expect(existsSync(withUserHooksOnly.tomlPath)).toBe(false)
  })
})
