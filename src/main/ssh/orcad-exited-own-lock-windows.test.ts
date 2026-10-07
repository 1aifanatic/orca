import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DeployHelpers from './ssh-relay-deploy-helpers'

// The host script's own checks are covered against the real script; here only the client's part.
const remote = vi.hoisted((): { commands: string[]; reply: string } => ({
  commands: [],
  reply: ''
}))
vi.mock('./ssh-relay-deploy-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DeployHelpers>()),
  execCommand: async (_conn: unknown, command: string) => {
    remote.commands.push(command)
    return command.includes('script-present') ? 'ORCAD_HOST_SCRIPT_PRESENT\n' : remote.reply
  }
}))

const { orphanExitedOwnLock } = await import('./orcad-exited-own-lock')
const { initOrcadHeldFenceTokenFile, ORCAD_HELD_FENCE_TOKENS_FILE_NAME } =
  await import('./orcad-held-fence-tokens')
const { getRemoteHostPlatform } = await import('./ssh-remote-platform')

// Above every Linux and macOS pid_max, so no process can hold it.
const EXITED_PID = 4_194_304 + 1
const host = getRemoteHostPlatform('win32-x64')
const baseDir = 'C:/Users/me/.orca-remote'
const lockDir = `${baseDir}/.orcad-activation-transaction/.install-lock`
let store = ''
let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orcad-exited-win-'))
  mkdirSync(join(home, 'data'))
  initOrcadHeldFenceTokenFile(join(home, 'data', 'orca-data.json'))
  store = join(home, 'data', ORCAD_HELD_FENCE_TOKENS_FILE_NAME)
  remote.commands = []
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

function hold(...entries: { token: string; pid: number }[]): void {
  const bootedAt = Date.now() - uptime() * 1000
  writeFileSync(
    store,
    JSON.stringify(entries.map((e) => ({ ...e, host: hostname(), bootedAt, at: Date.now() })))
  )
}

function orphan(guardsStateMutation: boolean): Promise<boolean> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked, so the connection is never used.
  const target = { conn: {} as never, host }
  return orphanExitedOwnLock(target, lockDir, { baseDir, guardsStateMutation })
}

const orphanOps = (): string[] => remote.commands.filter((c) => c.includes('fence-orphan-exited'))

describe('reclaiming this desktop’s exited lock on a Windows host', () => {
  it('asks the host script about exited holders only, and forgets the token it aged', async () => {
    hold({ token: 't-exited', pid: EXITED_PID }, { token: 't-live', pid: process.pid })
    remote.reply = 'ORPHANED t-exited\n'
    await expect(orphan(true)).resolves.toBe(true)
    const [op] = orphanOps()
    expect(op).toContain('t-exited')
    expect(op).not.toContain('t-live')
    expect(op).toMatch(/fence-orphan-exited"? "?[^ ]*\.install-lock"? "?1"?/u)
    expect(readFileSync(store, 'utf-8')).not.toContain('t-exited')
  })

  it('keeps the lock and the token when the host kept it', async () => {
    hold({ token: 't-exited', pid: EXITED_PID })
    remote.reply = 'KEPT\n'
    await expect(orphan(false)).resolves.toBe(false)
    expect(orphanOps()).toHaveLength(1)
    expect(readFileSync(store, 'utf-8')).toContain('t-exited')
  })

  it('ignores an answer naming a token it did not offer', async () => {
    hold({ token: 't-exited', pid: EXITED_PID })
    remote.reply = 'ORPHANED t-foreign\n'
    await expect(orphan(false)).resolves.toBe(false)
  })

  it('asks the host nothing while no holder is proven exited', async () => {
    hold({ token: 't-live', pid: process.pid })
    await expect(orphan(true)).resolves.toBe(false)
    expect(remote.commands).toEqual([])
  })
})
