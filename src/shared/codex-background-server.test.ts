import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexBackgroundServerRunning } from './codex-background-server'

// Above every platform's pid ceiling, so signalling it always reports no such process.
const DEAD_PID = 2_147_483_646

describe('codexBackgroundServerRunning', () => {
  let home: string
  let rollout: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codex-home-'))
    rollout = join(home, 'sessions', '2026', '09', '27', 'rollout-2026-09-27T10-00-00-root.jsonl')
    mkdirSync(join(home, 'app-server-daemon'), { recursive: true })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function writePidRecord(name: string, pid: unknown): void {
    writeFileSync(
      join(home, 'app-server-daemon', name),
      JSON.stringify({ pid, processStartTime: 'Sun Sep 27 10:00:00 2026' })
    )
  }

  it('reads the server of the rollout’s Codex home from its pid record', () => {
    expect(codexBackgroundServerRunning(rollout)).toBe(false)
    writePidRecord('daemon.pid', process.pid)
    expect(codexBackgroundServerRunning(rollout)).toBe(true)
  })

  it('reads the legacy record name too', () => {
    writePidRecord('app-server.pid', process.pid)
    expect(codexBackgroundServerRunning(rollout)).toBe(true)
  })

  it('treats a record left behind by a killed server as stopped', () => {
    writePidRecord('daemon.pid', DEAD_PID)
    expect(codexBackgroundServerRunning(rollout)).toBe(false)
  })

  it('treats an unreadable record or a rollout outside a Codex home as no server', () => {
    writeFileSync(join(home, 'app-server-daemon', 'daemon.pid'), '')
    expect(codexBackgroundServerRunning(rollout)).toBe(false)
    writePidRecord('daemon.pid', 'not-a-pid')
    expect(codexBackgroundServerRunning(rollout)).toBe(false)
    writePidRecord('daemon.pid', process.pid)
    expect(codexBackgroundServerRunning(join(home, 'rollout-root.jsonl'))).toBe(false)
  })
})
