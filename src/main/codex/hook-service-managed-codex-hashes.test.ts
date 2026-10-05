import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import type * as InstallerUtils from '../agent-hooks/installer-utils'
import { isCodexManagedCommand, setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock, hooks } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>(),
  hooks: { beforeHooksJsonWrite: null as (() => void) | null }
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: homedirMock
}))
vi.mock('../agent-hooks/installer-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof InstallerUtils>()
  return {
    ...actual,
    writeHooksJson: (...args: Parameters<typeof actual.writeHooksJson>) => {
      hooks.beforeHooksJsonWrite?.()
      return actual.writeHooksJson(...args)
    }
  }
})

import { CodexHookService } from './hook-service'
import { _internals as reconcileInternals } from './codex-hook-reconcile'
import {
  computeTrustKey,
  getCodexExplicitHomeHookSourcePath,
  readHookTrustEntries,
  upsertHookTrustEntries
} from './config-toml-trust'
import { getManagedCommand, getManagedScriptPath } from './codex-hook-definition'

// Why this file: a managed CODEX_HOME's approval for Orca's entry is Codex's
// own hash, not one Orca computes, and is written before the entry.

const homes = setupCodexHookHomes(homedirMock, getPathMock)

const CODEX_HASHES = {
  session_start: 'sha256:codex-session_start',
  user_prompt_submit: 'sha256:codex-user_prompt_submit',
  pre_tool_use: 'sha256:codex-pre_tool_use',
  permission_request: 'sha256:codex-permission_request',
  post_tool_use: 'sha256:codex-post_tool_use',
  stop: 'sha256:codex-stop'
}

function managedHome(): string {
  return join(homes.userDataDir, 'codex-runtime-home', 'home')
}

function managedKey(eventLabel: string, groupIndex: number): string {
  return computeTrustKey({
    sourcePath: getCodexExplicitHomeHookSourcePath(join(managedHome(), 'hooks.json')),
    eventLabel: eventLabel as 'stop',
    groupIndex,
    handlerIndex: 0,
    command: getManagedCommand(getManagedScriptPath())
  })
}

function seedSystemUserStopHook(): void {
  const systemHome = join(homes.tmpHome, '.codex')
  mkdirSync(systemHome, { recursive: true })
  writeFileSync(
    join(systemHome, 'hooks.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-stop.sh' }] }] } })
  )
  upsertHookTrustEntries(join(systemHome, 'config.toml'), [
    {
      sourcePath: join(systemHome, 'hooks.json'),
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'user-stop.sh'
    }
  ])
}

function useCodexHashes(): void {
  reconcileInternals.setHashResolverForTesting(async () => ({
    codexVersion: 'codex-cli 0.131.0',
    hashes: CODEX_HASHES,
    failure: null
  }))
}

describe('managed-home Codex hook approval', () => {
  it("approves Orca's entry with Codex's hash, enabled, only in the events Codex lists", async () => {
    seedSystemUserStopHook()
    useCodexHashes()

    expect((await new CodexHookService().install()).state).toBe('installed')

    const runtimeHooks = JSON.parse(readFileSync(join(managedHome(), 'hooks.json'), 'utf-8')).hooks
    expect(Object.keys(runtimeHooks).sort()).toEqual(
      [
        'PermissionRequest',
        'PostToolUse',
        'PreToolUse',
        'SessionStart',
        'Stop',
        'UserPromptSubmit'
      ].sort()
    )
    expect(isCodexManagedCommand(runtimeHooks.Stop[0].hooks[0].command)).toBe(true)
    expect(runtimeHooks.Stop[1].hooks[0].command).toBe('user-stop.sh')
    const trust = readHookTrustEntries(join(managedHome(), 'config.toml'))
    expect(trust.get(managedKey('stop', 0))).toEqual({
      trustedHash: 'sha256:codex-stop',
      enabled: true
    })
    expect(trust.get(managedKey('subagent_start', 0))).toBeUndefined()
    // Why: the mirrored user hook moved behind Orca's group, and its approval with it.
    expect(
      trust.get(
        computeTrustKey({
          sourcePath: getCodexExplicitHomeHookSourcePath(join(managedHome(), 'hooks.json')),
          eventLabel: 'stop',
          groupIndex: 1,
          handlerIndex: 0,
          command: 'user-stop.sh'
        })
      )?.trustedHash
    ).toBeDefined()
  })

  it('writes the approval before the entry, and takes it back if the entry write fails', async () => {
    useCodexHashes()
    const approvedAtWrite: (string | undefined)[] = []
    hooks.beforeHooksJsonWrite = () => {
      approvedAtWrite.push(
        readHookTrustEntries(join(managedHome(), 'config.toml')).get(managedKey('stop', 0))
          ?.trustedHash
      )
      throw new Error('disk full')
    }
    try {
      expect((await new CodexHookService().install()).state).toBe('error')
    } finally {
      hooks.beforeHooksJsonWrite = null
    }

    expect(approvedAtWrite).toEqual(['sha256:codex-stop'])
    expect(
      readHookTrustEntries(join(managedHome(), 'config.toml')).get(managedKey('stop', 0))
    ).toBe(undefined)
  })

  it("keeps only the user's hooks when Codex gave no hash", async () => {
    seedSystemUserStopHook()
    reconcileInternals.setHashResolverForTesting(async () => ({
      codexVersion: 'codex-cli 0.128.0',
      hashes: null,
      failure: 'codex-cli 0.128.0 does not report hook approvals; update Codex for Orca status'
    }))

    const status = await new CodexHookService().install()

    const runtimeHooks = JSON.parse(readFileSync(join(managedHome(), 'hooks.json'), 'utf-8')).hooks
    expect(runtimeHooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'user-stop.sh' }] }])
    expect(status).toMatchObject({
      state: 'not_installed',
      detail: expect.stringContaining('does not report hook approvals')
    })
  })
})
