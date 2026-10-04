import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPtyStartupDiagnostic,
  PtyStartupDiagnostic,
  SSH_STARTUP_DIAGNOSTIC_LIMIT,
  sshStartupDiagnosticCommand
} from './pty-startup-diagnostic'

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-startup-observation-'))
  directories.push(directory)
  const file = join(directory, 'raw.jsonl')
  const observer = new PtyStartupDiagnostic(openSync(file, 'wx', 0o600))
  return { observer, file }
}

const identity = {
  id: 'owned-pty',
  incarnationId: 'owned-incarnation',
  pid: process.pid,
  slavePath: '/dev/pts/1',
  command: 'unrelated',
  providerDelivery: true,
  waitForShellReady: true
}

describe('isolated SSH startup observations', () => {
  it('refuses ordinary, unrelated, malformed and non-Linux launches', () => {
    const runId = 'ssh_1791111111111'
    expect(createPtyStartupDiagnostic(undefined, identity, 'linux')).toBeUndefined()
    expect(createPtyStartupDiagnostic(runId, identity, 'linux')).toBeUndefined()
    expect(createPtyStartupDiagnostic('../other', identity, 'linux')).toBeUndefined()
    expect(
      createPtyStartupDiagnostic(
        runId,
        { ...identity, command: sshStartupDiagnosticCommand(runId) },
        'win32'
      )
    ).toBeUndefined()
  })

  it('admits only the exact fixed command in its owned private directory', () => {
    const runId = `ssh_${Date.now()}`
    const directory = `/tmp/sta4067-diagnostic-${runId}`
    mkdirSync(directory, { mode: 0o700 })
    directories.push(directory)
    const admitted = createPtyStartupDiagnostic(
      runId,
      { ...identity, command: sshStartupDiagnosticCommand(runId) },
      'linux'
    )
    expect(admitted).toBeDefined()
    admitted?.close()
    const rows = readFileSync(join(directory, 'relay.jsonl'), 'utf8')
    expect(rows).toContain('owned-pty')
    expect(rows).toContain('owned-incarnation')
    expect(rows).toContain('commandSha256')
    expect(rows).not.toContain('PATH')
    expect(
      createPtyStartupDiagnostic(
        runId,
        { ...identity, command: sshStartupDiagnosticCommand(runId) },
        'linux'
      )
    ).toBeUndefined()
  })

  it('refuses a public directory instead of capturing a terminal there', () => {
    const runId = `ssh_${Date.now()}`
    const directory = `/tmp/sta4067-diagnostic-${runId}`
    mkdirSync(directory, { mode: 0o755 })
    directories.push(directory)
    expect(
      createPtyStartupDiagnostic(
        runId,
        { ...identity, command: sshStartupDiagnosticCommand(runId) },
        'linux'
      )
    ).toBeUndefined()
  })

  it('keeps the native write successful when diagnostic storage fails', () => {
    const observer = new PtyStartupDiagnostic(-1)
    const operation = vi.fn()
    expect(() => observer.write('fixed-payload', operation)).not.toThrow()
    expect(operation).toHaveBeenCalledOnce()
  })

  it('records original escapes and chunk boundaries before and after filtering', () => {
    const { observer, file } = fixture()
    const raw = '\x1b]777;orca-shell-start:123\x07\r\n'
    observer.output('native-output', raw)
    observer.output('ingress-output', '\r\n')
    observer.close()
    const rows = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row))
    expect(rows.map((row) => row.event)).toEqual(['native-output', 'ingress-output'])
    expect(Buffer.from(rows[0].dataBase64, 'base64').toString()).toBe(raw)
    expect(rows[0].sequence).toBe(1)
    expect(rows[1].sequence).toBe(2)
  })

  it('writes once and preserves the exact native write error', () => {
    const { observer, file } = fixture()
    const failure = new Error('original native failure')
    const operation = vi.fn(() => {
      throw failure
    })
    expect(() => observer.write('fixed-payload', operation)).toThrow(failure)
    expect(operation).toHaveBeenCalledOnce()
    observer.close()
    expect(readFileSync(file, 'utf8')).toContain('native-write-threw')
    expect(readFileSync(file, 'utf8')).not.toContain(failure.message)
  })

  it('bounds captured bytes and remains observational after the limit or close', () => {
    const { observer, file } = fixture()
    observer.output('native-output', 'x'.repeat(SSH_STARTUP_DIAGNOSTIC_LIMIT + 1))
    observer.record('scheduled', { delayMs: 1500 })
    const operation = vi.fn()
    observer.write('fixed-payload', operation)
    expect(operation).toHaveBeenCalledOnce()
    expect(Buffer.byteLength(readFileSync(file))).toBeLessThanOrEqual(SSH_STARTUP_DIAGNOSTIC_LIMIT)
    expect(readFileSync(file, 'utf8')).toContain('capture-limit')
    expect(readFileSync(file, 'utf8')).not.toContain('scheduled')
  })
})
