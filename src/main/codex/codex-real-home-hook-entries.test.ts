import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapPosixHookCommand, type HookDefinition } from '../agent-hooks/installer-utils'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('node:os')),
  homedir: homedirMock
}))

import { reconcileRealHomeCodexHookEntries } from './codex-real-home-hook-install'
import { buildCodexManagedHook, getCodexManagedHookInstallMaterial } from './codex-hook-definition'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import { computeCodexHookHashesForTests } from './hook-service-test-harness'
import {
  computeTrustKey,
  computeTrustedHash,
  readHookTrustEntries,
  upsertHookTrustEntries
} from './config-toml-trust'

// Why this file: every Orca instance and build on one HOME shares ~/.codex, and
// the user's own hooks and approvals live beside Orca's entry there.

type HooksFile = { hooks: Record<string, HookDefinition[]> }

const USER_A: HookDefinition = { hooks: [{ type: 'command', command: 'user-a.sh' }] }
const USER_B: HookDefinition = { hooks: [{ type: 'command', command: 'user-b.sh' }] }
const USER_C: HookDefinition = { hooks: [{ type: 'command', command: 'user-c.sh' }] }

let home: string
let userData: string

const hooksPath = (): string => join(home, '.codex', 'hooks.json')
const configPath = (): string => join(home, '.codex', 'config.toml')
const frozen = (): string => getCodexManagedHookInstallMaterial().command
const orcaGroup = (command: string): HookDefinition => ({
  hooks: [buildCodexManagedHook(command, 'Stop')]
})

function olderBuildCommand(): string {
  const script = join(home, '.orca', 'agent-hooks', 'codex-hook.sh')
  return process.platform === 'win32' ? script : wrapPosixHookCommand(script)
}

function writeHooks(file: unknown): string {
  mkdirSync(join(home, '.codex'), { recursive: true })
  const raw = `${JSON.stringify(file, null, 2)}\n`
  writeFileSync(hooksPath(), raw)
  return raw
}

function readHooks(): HooksFile {
  return JSON.parse(readFileSync(hooksPath(), 'utf-8'))
}

function identity(path: string): { raw: string; ino: number; mtimeMs: number } {
  const stat = statSync(path)
  return { raw: readFileSync(path, 'utf-8'), ino: stat.ino, mtimeMs: stat.mtimeMs }
}

async function reconcile(userDataPath = userData, convertOlderForms = true): Promise<string> {
  return (
    await reconcileRealHomeCodexHookEntries({
      hashes: computeCodexHookHashesForTests(),
      isEnabled: () => true,
      userDataPath,
      convertOlderForms
    })
  ).outcome
}

function expectApproved(file: HooksFile, groupIndexes: number[]): void {
  const trust = readHookTrustEntries(configPath())
  for (const groupIndex of groupIndexes) {
    const group = file.hooks.Stop![groupIndex]!
    const entry = createCodexHookTrustEntry(
      hooksPath(),
      'Stop',
      groupIndex,
      0,
      group,
      group.hooks![0]!
    )!
    expect(trust.get(computeTrustKey(entry))).toEqual({
      trustedHash: computeTrustedHash(entry),
      enabled: true
    })
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-real-home-entries-home-'))
  userData = mkdtempSync(join(tmpdir(), 'orca-real-home-entries-user-data-'))
  homedirMock.mockReturnValue(home)
  vi.stubEnv('CODEX_HOME', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

describe('reconcileRealHomeCodexHookEntries', () => {
  it("converts an older build's entry once, in its slot, with one pristine backup", async () => {
    const olderRaw = writeHooks({ hooks: { Stop: [USER_A, orcaGroup(olderBuildCommand())] } })

    expect(await reconcile()).toBe('written')
    const converted = identity(hooksPath())
    expect(readHooks().hooks.Stop).toEqual([USER_A, orcaGroup(frozen())])
    expectApproved(readHooks(), [1])
    expect(
      readFileSync(join(userData, 'codex-real-home-hooks', 'hooks.json.pre-orca'), 'utf-8')
    ).toBe(olderRaw)

    const otherInstance = mkdtempSync(join(tmpdir(), 'orca-real-home-entries-second-'))
    try {
      expect(await reconcile(otherInstance)).toBe('unchanged')
    } finally {
      rmSync(otherInstance, { recursive: true, force: true })
    }
    expect(identity(hooksPath())).toEqual(converted)
  })

  it("writes zero bytes beside an older build's entries on a launch", async () => {
    const { events } = getCodexManagedHookInstallMaterial()
    writeHooks({
      hooks: Object.fromEntries(
        events.map((event) => [
          event,
          [{ hooks: [buildCodexManagedHook(olderBuildCommand(), event)] }]
        ])
      )
    })
    const before = identity(hooksPath())

    expect(await reconcile(userData, false)).toBe('unchanged')

    expect(identity(hooksPath())).toEqual(before)
    expect(existsSync(configPath())).toBe(false)
  })

  it("leaves only the older build's events on a launch, and re-approves its own after a shift", async () => {
    writeHooks({ hooks: { Stop: [USER_A, orcaGroup(olderBuildCommand())] } })

    expect(await reconcile(userData, false)).toBe('written')

    expect(readHooks().hooks.Stop).toEqual([USER_A, orcaGroup(olderBuildCommand())])
    expect(readHooks().hooks.SessionStart).toEqual([
      { hooks: [buildCodexManagedHook(frozen(), 'SessionStart')] }
    ])
    expect(await reconcile(userData, true)).toBe('written')
    const stop = readHooks().hooks.Stop!
    writeHooks({ hooks: { ...readHooks().hooks, Stop: [USER_B, ...stop] } })
    // Why: with no older entry left, a launch re-approves this build's entry after a key shift.
    expect(await reconcile(userData, false)).toBe('written')
    expectApproved(readHooks(), [2])
  })

  it('never rewrites a newer build form or appends beside it', async () => {
    const newer = `: orca-agent-hook-form=2; /bin/sh "\${HOME-}/.orca/agent-hooks/codex-hook.sh"`
    writeHooks({ hooks: { Stop: [orcaGroup(newer)] } })

    await reconcile()

    expect(readHooks().hooks.Stop).toEqual([orcaGroup(newer)])
  })

  it('keeps Orca entries in events this build does not subscribe to', async () => {
    const otherEvent = [orcaGroup(frozen())]
    writeHooks({ hooks: { PreCompact: otherEvent } })

    expect(await reconcile()).toBe('written')

    expect(readHooks().hooks.PreCompact).toEqual(otherEvent)
  })

  it('collapses a trailing duplicate but keeps one a user hook follows, approving both copies', async () => {
    writeHooks({
      hooks: {
        Stop: [
          USER_A,
          orcaGroup(frozen()),
          USER_B,
          orcaGroup(frozen()),
          USER_C,
          orcaGroup(frozen())
        ]
      }
    })

    await reconcile()

    const after = readHooks()
    expect(after.hooks.Stop).toEqual([
      USER_A,
      orcaGroup(frozen()),
      USER_B,
      orcaGroup(frozen()),
      USER_C
    ])
    expectApproved(after, [1, 3])
  })

  it("keeps user hooks' positions and approvals while appending Orca's entry", async () => {
    writeHooks({ hooks: { Stop: [USER_A, USER_B] } })
    const userEntry = createCodexHookTrustEntry(
      hooksPath(),
      'Stop',
      1,
      0,
      USER_B,
      USER_B.hooks![0]!
    )!
    upsertHookTrustEntries(configPath(), [{ ...userEntry, trustedHash: 'sha256:user' }])
    const userToml = readFileSync(configPath(), 'utf-8')

    await reconcile()

    expect(readHooks().hooks.Stop).toEqual([USER_A, USER_B, orcaGroup(frozen())])
    // Why a prefix: Orca's approval blocks are only appended after the user's bytes.
    expect(readFileSync(configPath(), 'utf-8').startsWith(userToml)).toBe(true)
    expect(readHookTrustEntries(configPath()).get(computeTrustKey(userEntry))?.trustedHash).toBe(
      'sha256:user'
    )
  })

  it.each([
    ['unknown top-level fields Codex cannot load', { hooks: {}, _managed: true }],
    ['an unparseable file', '{ not json']
  ])('leaves %s untouched and approves nothing', async (_case, content) => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(hooksPath(), typeof content === 'string' ? content : JSON.stringify(content))
    const before = identity(hooksPath())

    expect(await reconcile()).toBe('unavailable')

    expect(identity(hooksPath())).toEqual(before)
    expect(existsSync(configPath())).toBe(false)
  })

  it('keeps the original bytes, and takes the approvals back, when the pristine backup fails', async () => {
    const original = writeHooks({ hooks: { Stop: [USER_A] } })
    writeFileSync(join(userData, 'codex-real-home-hooks'), 'blocks the backup folder')

    expect(await reconcile()).toBe('unavailable')

    expect(readFileSync(hooksPath(), 'utf-8')).toBe(original)
    expect(readHookTrustEntries(configPath()).size).toBe(0)
  })

  it.skipIf(process.platform === 'win32')(
    'updates a symlinked hooks.json in place, keeping its permissions',
    async () => {
      const target = join(home, 'dotfiles', 'hooks.json')
      mkdirSync(join(home, 'dotfiles'), { recursive: true })
      mkdirSync(join(home, '.codex'), { recursive: true })
      writeFileSync(target, `${JSON.stringify({ hooks: { Stop: [USER_A] } }, null, 2)}\n`)
      chmodSync(target, 0o600)
      symlinkSync(target, hooksPath())

      expect(await reconcile()).toBe('written')

      expect(lstatSync(hooksPath()).isSymbolicLink()).toBe(true)
      expect(JSON.parse(readFileSync(target, 'utf-8')).hooks.Stop).toHaveLength(2)
      expect(statSync(target).mode & 0o777).toBe(0o600)
    }
  )
})
