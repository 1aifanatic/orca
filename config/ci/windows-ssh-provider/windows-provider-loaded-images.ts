import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { readWindowsProcessTableFresh } from '../windows/windows-process-table'
import { WINDOWS_CONPTY_FILES } from '../../shared/windows-conpty-release'

export async function inspectProviderImages(
  daemon: { pid: number; creationTimeMs?: number },
  relayDirectory: string
) {
  assert(Number.isInteger(daemon.pid) && daemon.pid > 0 && daemon.creationTimeMs)
  const before = await readWindowsProcessTableFresh()
  assert(
    before.some((row) => row.pid === daemon.pid && row.creationTimeMs === daemon.creationTimeMs)
  )
  const descendants = new Set([daemon.pid])
  for (let changed = true; changed;) {
    changed = false
    for (const row of before) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid)
        changed = true
      }
    }
  }
  const consoles = before.filter(
    (row) => descendants.has(row.pid) && row.name.toLowerCase() === 'openconsole.exe'
  )
  assert(consoles.length > 0, 'no owned OpenConsole descendant')
  for (const row of consoles)
    assert(row.creationTimeMs, 'OpenConsole creation identity unavailable')
  // Scoped module/image query only; process enumeration uses the existing native table.
  const runInspection = async (script: string, label: string) => {
    const result = await runProcess({
      program: join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      ),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      timeoutMs: 15000,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      maxOutputBytes: 65536
    })
    if (result.timedOut || result.code !== 0) {
      const stderr = result.stderr.replace(/[^\x20-\x7e\r\n]/g, '').slice(0, 512)
      throw new Error(
        `${label} inspection failed (code=${String(result.code)} timedOut=${String(result.timedOut)} stderr=${stderr})`
      )
    }
    return JSON.parse(result.stdout)
  }
  const daemonEvidence = await runInspection(
    `$ErrorActionPreference='Stop'; $p=[Diagnostics.Process]::GetProcessById(${daemon.pid}); @($p.Modules | Where-Object {$_.ModuleName -ieq 'conpty.dll'} | ForEach-Object {$_.FileName}) | ConvertTo-Json -Compress`,
    'daemon module'
  )
  const imageEvidence = await Promise.all(
    consoles.map((row) =>
      runInspection(
        `$ErrorActionPreference='Stop'; $p=[Diagnostics.Process]::GetProcessById(${row.pid}); @{pid=$p.Id;path=$p.MainModule.FileName;creationTimeMs=([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()} | ConvertTo-Json -Compress`,
        `OpenConsole ${row.pid}`
      )
    )
  )
  const evidence = {
    modules: Array.isArray(daemonEvidence) ? daemonEvidence : [daemonEvidence],
    images: imageEvidence
  }
  assert(Array.isArray(evidence.modules) && evidence.modules.length === 1)
  const samePath = (a: string, b: string) =>
    realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase()
  assert(
    samePath(evidence.modules[0], join(relayDirectory, 'conpty.dll')),
    'relay loaded foreign ConPTY'
  )
  assert(Array.isArray(evidence.images) && evidence.images.length === consoles.length)
  for (const image of evidence.images) {
    const original = consoles.find((row) => row.pid === image.pid)
    assert(
      original?.creationTimeMs && Math.abs(original.creationTimeMs - image.creationTimeMs) <= 1,
      'console identity changed during query'
    )
    assert(
      samePath(image.path, join(relayDirectory, 'OpenConsole.exe')),
      'foreign OpenConsole image'
    )
    assert.equal(
      createHash('sha256').update(readFileSync(image.path)).digest('hex'),
      WINDOWS_CONPTY_FILES.arm64['OpenConsole.exe']
    )
  }
  assert.equal(
    createHash('sha256').update(readFileSync(evidence.modules[0])).digest('hex'),
    WINDOWS_CONPTY_FILES.arm64['conpty.dll']
  )
  const after = await readWindowsProcessTableFresh()
  for (const original of [daemon, ...consoles]) {
    assert(
      after.some(
        (row) => row.pid === original.pid && row.creationTimeMs === original.creationTimeMs
      ),
      'owner changed during module observation'
    )
  }
  const descendantIdentities = before
    .filter((row) => descendants.has(row.pid) && row.pid !== daemon.pid)
    .map((row) => {
      assert(typeof row.creationTimeMs === 'number', 'descendant cleanup identity unavailable')
      return { pid: row.pid, creationTimeMs: row.creationTimeMs }
    })
  return { ...evidence, providerHashes: WINDOWS_CONPTY_FILES.arm64, daemon, descendantIdentities }
}
