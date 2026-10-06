import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import {
  captureOrcadStateSnapshotCommand,
  clearOrcadStateSnapshotMembersCommand,
  parseOrcadSnapshotCapture,
  parseOrcadSnapshotRestore,
  restoreOrcadStateSnapshotCommand
} from './orcad-state-snapshot'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')

async function sh(command: string): Promise<string> {
  const result = await runProcess({ program: '/bin/sh', args: ['-c', command] })
  return result.stdout
}

describe.skipIf(process.platform === 'win32')('snapshot commands on a real shell', () => {
  let base: string
  let root: string
  let snapshot: string
  let remoteBase: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'orcad-snapshot-shell-'))
    root = join(base, 'root')
    snapshot = join(base, 'snapshots', 'pre-1')
    remoteBase = join(base, '.orca-remote')
    mkdirSync(join(root, 'profiles'), { recursive: true })
    mkdirSync(join(root, 'daemon'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'p.json'), 'old')
    writeFileSync(join(root, 'daemon', 'token'), 'live-daemon')
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('restores members, drops files the newer build added, and leaves the daemon alone', async () => {
    expect(
      parseOrcadSnapshotCapture(
        await sh(captureOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
      )
    ).toBe('captured')
    writeFileSync(join(root, 'profiles', 'p.json'), 'migrated')
    writeFileSync(join(root, 'profiles', 'added.json'), 'new')
    writeFileSync(join(root, 'daemon', 'token'), 'rotated')

    expect(
      parseOrcadSnapshotRestore(
        await sh(restoreOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
      )
    ).toBe('restored')
    expect(readFileSync(join(root, 'profiles', 'p.json'), 'utf8')).toBe('old')
    expect(existsSync(join(root, 'profiles', 'added.json'))).toBe(false)
    expect(readFileSync(join(root, 'daemon', 'token'), 'utf8')).toBe('rotated')
    expect(existsSync(join(root, '.orcad-state-restore-stage'))).toBe(false)
  })

  it('keeps live state when the archive cannot be extracted', async () => {
    await sh(captureOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
    writeFileSync(join(snapshot, 'state.tar'), 'not a tar archive')
    writeFileSync(join(root, 'profiles', 'p.json'), 'current')

    expect(
      parseOrcadSnapshotRestore(
        await sh(restoreOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
      )
    ).toBe('failed')
    expect(readFileSync(join(root, 'profiles', 'p.json'), 'utf8')).toBe('current')
  })

  it('reruns cleanly after a restore interrupted between removal and replacement', async () => {
    await sh(captureOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
    // Simulates a crash that left the stage behind and the live members already removed.
    mkdirSync(join(root, '.orcad-state-restore-stage', 'profiles'), { recursive: true })
    rmSync(join(root, 'profiles'), { recursive: true })

    expect(
      parseOrcadSnapshotRestore(
        await sh(restoreOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
      )
    ).toBe('restored')
    expect(readFileSync(join(root, 'profiles', 'p.json'), 'utf8')).toBe('old')
  })

  it('clears only the snapshot members for a root that started empty', async () => {
    expect(
      parseOrcadSnapshotRestore(
        await sh(clearOrcadStateSnapshotMembersCommand(posix, root, remoteBase))
      )
    ).toBe('restored')
    expect(existsSync(join(root, 'profiles'))).toBe(false)
    expect(readFileSync(join(root, 'daemon', 'token'), 'utf8')).toBe('live-daemon')
  })

  it('answers busy and leaves state alone while another state mutation holds the host lock', async () => {
    await sh(captureOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
    writeFileSync(join(root, 'profiles', 'p.json'), 'current')
    const lock = join(remoteBase, 'orcad-state-mutation.lock')
    mkdirSync(lock)
    // This test process is alive, so it reads as a restore still running.
    writeFileSync(join(lock, 'pid'), String(process.pid))

    const output = await sh(restoreOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
    expect(output.trim()).toBe('STATE_MUTATION_BUSY')
    expect(readFileSync(join(root, 'profiles', 'p.json'), 'utf8')).toBe('current')
    expect(existsSync(lock)).toBe(true)
  })

  it('takes over a lock whose holder is gone, and releases it when done', async () => {
    await sh(captureOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
    writeFileSync(join(root, 'profiles', 'p.json'), 'current')
    const lock = join(remoteBase, 'orcad-state-mutation.lock')
    mkdirSync(lock)
    const exited = (await runProcess({ program: '/bin/sh', args: ['-c', 'echo $$'] })).stdout
    writeFileSync(join(lock, 'pid'), exited.trim())

    expect(
      parseOrcadSnapshotRestore(
        await sh(restoreOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
      )
    ).toBe('restored')
    expect(readFileSync(join(root, 'profiles', 'p.json'), 'utf8')).toBe('old')
    expect(existsSync(lock)).toBe(false)
  })
})
