#!/usr/bin/env node
// Diagnostic-only: reduce a Chromium trace to its begin-frame decisions, keeping the raw file.
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { argv } from 'node:process'

const source = argv[2]
const summaryPath = argv[3]
const gzipPath = argv[4]

const raw = await readFile(source, 'utf8')
let parsed
try {
  parsed = JSON.parse(raw)
} catch {
  // Chromium can leave a truncated array open when recording stops mid-write.
  parsed = JSON.parse(`${raw.replace(/,\s*$/, '')}]}`)
}
const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? [])

const decisions = []
const byReason = {}
for (const event of events) {
  if (event.name !== 'SendBeginFrameDecision') continue
  const reason = String(event.args?.reason ?? 'unknown')
  const shouldSend = Boolean(event.args?.should_send)
  const key = `${reason}:${shouldSend}`
  byReason[key] = (byReason[key] ?? 0) + 1
  decisions.push({ ts: event.ts, pid: event.pid, tid: event.tid, reason, shouldSend })
}

const markers = events
  .filter((event) => typeof event.name === 'string' && event.name.startsWith('orca-sidebar-frame-capture'))
  .map((event) => ({ name: event.name, ts: event.ts, ph: event.ph, pid: event.pid, tid: event.tid }))

const clockSyncs = events
  .filter((event) => event.name === 'clock_sync' || event.name === 'TracingStartedInBrowser')
  .map((event) => ({ name: event.name, ts: event.ts, args: event.args }))

await writeFile(
  summaryPath,
  JSON.stringify(
    {
      source,
      sourceBytes: (await stat(source)).size,
      traceEvents: events.length,
      decisionCountsByReasonAndShouldSend: byReason,
      decisions,
      capturePhaseMarkers: markers,
      clockSyncEvents: clockSyncs
    },
    null,
    2
  )
)
await pipeline(createReadStream(source), createGzip({ level: 9 }), createWriteStream(gzipPath))
console.log(`reduced ${source}: ${events.length} events, ${decisions.length} decisions`)
