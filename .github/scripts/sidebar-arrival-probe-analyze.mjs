#!/usr/bin/env node
/**
 * Diagnostic-only analysis: locate the largest forward single-frame jump in each captured case and
 * report what changed across it — script writes, scroll extent, and target geometry — so a jump can
 * be attributed rather than assumed. Reads only files the probe wrote; changes nothing.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { argv } from 'node:process'

const evidence = argv[2]
const outPath = argv[3]

async function loadCases(root) {
  const cases = []
  for (const label of (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('case-'))
    .map((entry) => entry.name)
    .sort()) {
    for (const name of ['arrival-probe-frames.json', 'smooth-reveal-frames.json']) {
      const hits = []
      const walk = async (dir) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) await walk(path)
          else if (entry.name === name) hits.push(path)
        }
      }
      await walk(join(root, label)).catch(() => {})
      if (hits.length > 0) {
        cases.push({ label, instrumented: name.startsWith('arrival'), path: hits[0] })
        break
      }
    }
  }
  return cases
}

const report = []
for (const entry of await loadCases(evidence)) {
  const data = JSON.parse(await readFile(entry.path, 'utf8'))
  const samples = data.samples ?? []
  const arrivalIndex = samples.findIndex((sample) => sample.time === data.arrivalMs)
  const upTo = arrivalIndex >= 0 ? arrivalIndex : samples.length - 1
  const steps = []
  for (let index = 0; index < upTo; index++) {
    const from = samples[index]
    const to = samples[index + 1]
    steps.push({ index, fromTime: from.time, toTime: to.time, deltaPx: to.scrollTop - from.scrollTop, from, to })
  }
  const forward = steps.filter((step) => step.deltaPx > 0)
  const largest = forward.reduce((best, step) => (best && best.deltaPx >= step.deltaPx ? best : step), null)
  const writes = data.writeLog?.writes ?? []
  const record = {
    label: entry.label,
    instrumented: entry.instrumented,
    targetIndex: data.targetIndex,
    idleMs: data.idleMs,
    status: data.status,
    captureTimedOut: data.captureTimedOut ?? null,
    rafCaptureTimedOut: data.rafCaptureTimedOut ?? null,
    missingSampleCount: data.missingSampleCount ?? null,
    arrivalMs: data.arrivalMs,
    longestPause: data.longestPause,
    maxFrameGap: data.maxFrameGap,
    initialOffset: data.initialOffset,
    finalOffset: data.finalOffset,
    samples: samples.length,
    maxSampleIntervalMs: steps.reduce((best, step) => Math.max(best, step.toTime - step.fromTime), 0),
    largestForwardJumpPx: largest?.deltaPx ?? null,
    largestForwardJumpAtMs: largest?.toTime ?? null,
    largestForwardJumpIntervalMs: largest ? largest.toTime - largest.fromTime : null
  }
  if (largest && entry.instrumented) {
    const { from, to } = largest
    record.acrossJump = {
      writesSinceLastSample: to.writesSinceLastSample,
      lastWriteSeq: to.lastWriteSeq,
      scrollHeightBefore: from.scrollHeight,
      scrollHeightAfter: to.scrollHeight,
      scrollHeightDelta: to.scrollHeight - from.scrollHeight,
      maxScrollTopBefore: from.maxScrollTop,
      maxScrollTopAfter: to.maxScrollTop,
      offsetAtMaxBefore: from.scrollTop === from.maxScrollTop,
      offsetAtMaxAfter: to.scrollTop === to.maxScrollTop,
      targetTopBefore: from.top,
      targetTopAfter: to.top,
      scrollerGenerationBefore: from.scrollerGeneration,
      scrollerGenerationAfter: to.scrollerGeneration,
      // The discriminator: a delta with no intervening write is browser-driven motion.
      attribution:
        to.writesSinceLastSample > 0
          ? 'script write in this interval'
          : to.scrollHeight !== from.scrollHeight
            ? 'no write; extent changed in this interval'
            : 'no write; extent unchanged'
    }
    record.writeLog = {
      totalWrites: data.writeLog.totalWrites,
      nestedWrites: data.writeLog.nestedWrites,
      byKind: data.writeLog.byKind,
      smoothWrites: data.writeLog.smoothWrites,
      // Unchanged immediate read-back is normal for a smooth write; it is not a dropped write.
      immediateOffsetUnchangedWrites: data.writeLog.immediateOffsetUnchangedWrites,
      threwWrites: data.writeLog.threwWrites,
      truncatedEntries: data.writeLog.truncatedEntries,
      generationCount: data.writeLog.generationCount,
      missingSamples: data.writeLog.missingSamples?.length ?? 0,
      outerWrites: writes
        .filter((write) => write.nestedInSeq === null)
        .map((write) => ({
          seq: write.seq,
          timeMs: write.timeMs,
          kind: write.kind,
          behavior: write.behavior,
          argShape: write.argShape,
          fromTop: write.fromTop,
          requestedTop: write.requestedTop,
          appliedTop: write.appliedTop,
          immediateOffsetUnchanged: write.immediateOffsetUnchanged,
          threw: write.threw,
          generation: write.scrollerGeneration,
          stackHead: write.stack[0] ?? null
        }))
    }
    record.distinctScrollHeights = [...new Set(samples.slice(0, upTo + 1).map((s) => s.scrollHeight))]
  }
  report.push(record)
}

await writeFile(outPath, `${JSON.stringify({ evidence, cases: report }, null, 2)}\n`)
for (const entry of report) {
  console.log(
    `${entry.label} status=${entry.status} arrival=${entry.arrivalMs} jump=${entry.largestForwardJumpPx}px` +
      (entry.acrossJump ? ` attribution="${entry.acrossJump.attribution}" extentDelta=${entry.acrossJump.scrollHeightDelta}` : '')
  )
}
