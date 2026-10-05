import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.env.GITHUB_WORKSPACE
const home = process.env.ORCA_TYPECHECK_PILOT_HOME
const reports = join(home, 'reports')
const { runProcessSync } = await import(
  pathToFileURL(join(root, 'config/scripts/script-child-process.mjs'))
)
const started = Date.now()
const peaks = new Map()
while (!existsSync(join(home, 'monitor.done'))) {
  if (Date.now() - started > 9 * 60_000) {
    throw new Error('Bounded typecheck monitor expired')
  }
  const result = runProcessSync({
    program: '/bin/ps',
    args: ['-axo', 'pid=,ppid=,rss='],
    timeoutMs: 2_000,
    maxOutputBytes: 2 * 1024 * 1024
  })
  if (result.code !== 0 || result.outputTruncated || result.timedOut) {
    throw new Error('Memory census failed')
  }
  const rows = result.stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
  for (const label of readdirSync(reports)) {
    const directory = join(reports, label)
    if (!existsSync(join(directory, 'start.json')) || existsSync(join(directory, 'sealed.json'))) {
      continue
    }
    const roots = new Set(
      readdirSync(directory)
        .filter((name) => /^\d+\.json$/.test(name))
        .map((name) => Number(name.slice(0, -5)))
    )
    let changed = true
    while (changed) {
      changed = false
      for (const [pid, parent] of rows) {
        if (roots.has(parent) && !roots.has(pid)) {
          roots.add(pid)
          changed = true
        }
      }
    }
    if (
      process.env.SCENARIO === 'cancel' &&
      label === 'control' &&
      !existsSync(join(home, 'cancel-hold-ready.json'))
    ) {
      const workers = readdirSync(directory)
        .filter((name) => /^\d+\.json$/.test(name))
        .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')))
      const held = workers.filter((worker) => worker.preToolHeld && worker.phase === 'boot')
      const alive = new Set(rows.map(([pid]) => pid))
      if (
        workers.length === 3 &&
        held.length === 2 &&
        workers.every((worker) => alive.has(worker.pid))
      ) {
        const receipt = {
          sourceSha: process.env.SOURCE_REF.toLowerCase(),
          readyUnixMs: Date.now(),
          heldCompilerPids: held.map((worker) => worker.pid),
          observedAliveWorkerPids: workers.map((worker) => worker.pid),
          workers,
          scope:
            'Cancellation-only pre-tool hold: real installed compiler entrypoint processes are booted and alive; checking has not begun. Excluded from healthy timing.'
        }
        const destination = join(home, 'cancel-hold-ready.json')
        writeFileSync(`${destination}.tmp`, JSON.stringify(receipt, null, 2))
        renameSync(`${destination}.tmp`, destination)
        console.log(
          'CANCELLATION_HOLD_READY: real production/test compiler processes and ratchet parent are alive'
        )
      }
    }
    const rss = rows.reduce((sum, [pid, , value]) => sum + (roots.has(pid) ? value : 0), 0)
    const peak = Math.max(peaks.get(label) ?? 0, rss)
    peaks.set(label, peak)
    const destination = join(directory, 'memory.json')
    writeFileSync(
      `${destination}.tmp`,
      JSON.stringify({
        peakSampledRssKiB: peak,
        samplingIntervalMs: 200,
        measuredProcesses:
          'Guard-booted stage processes and their observed descendants; aggregate RSS, not a kernel peak'
      })
    )
    renameSync(`${destination}.tmp`, destination)
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
}
console.log(JSON.stringify({ monitor: 'finished', stages: [...peaks].length }))
