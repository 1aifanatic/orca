import { readFileSync } from 'node:fs'
import type { CrashReportDetailValue } from '../../shared/crash-reporting'

// ─── Linux kernel OOM-kill attribution ──────────────────────────────
// Why: a Linux renderer SIGKILL (exit 9) with main surviving looks the same
// whether the kernel OOM killer (global, or a memory limit on Orca's systemd
// scope) or a userspace killer (earlyoom, systemd-oomd, a script) sent it.
// Chromium raises renderer oom_score_adj, so the kernel picks a 135 MB renderer
// over a multi-GB agent. The kernel counts every OOM kill, so a counter delta
// across the death separates the two without root.

type CrashReportDetails = Record<string, CrashReportDetailValue>

export type LinuxOomKillCounters = {
  /** Host-wide kills from /proc/vmstat (kernel 4.13+). */
  vmstatOomKill?: number
  /** Kills of processes inside Orca's cgroup v2 subtree, any OOM killer kind. */
  cgroupOomKill?: number
  /** Nearest memory.max at or above Orca's cgroup; undefined when unlimited. */
  cgroupMemoryMaxMB?: number
  /** PSI `some avg10` from /proc/pressure/memory, percent. */
  memoryPressureSomeAvg10?: number
}

type FileReader = (path: string) => string | undefined

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

let fileReader: FileReader = readTextFile
let counterPlatform: NodeJS.Platform = process.platform

export function setLinuxOomKillFileReaderForTest(
  reader: FileReader | null,
  platform: NodeJS.Platform = process.platform
): void {
  fileReader = reader ?? readTextFile
  counterPlatform = platform
}

function keyedCounter(text: string | undefined, key: string): number | undefined {
  const match = text?.match(new RegExp(`^${key} (\\d+)$`, 'm'))
  return match ? Number(match[1]) : undefined
}

/** cgroup v2 path from the unified `0::/path` line; v1-only hosts have none. */
function ownCgroupPath(): string | undefined {
  const match = fileReader('/proc/self/cgroup')?.match(/^0::(\/.*)$/m)
  return match?.[1]
}

function nearestMemoryMaxMB(cgroupPath: string): number | undefined {
  // Why walk up: uwsm/systemd usually puts the limit on a parent slice, not the app scope.
  const segments = cgroupPath.split('/').filter(Boolean)
  for (let depth = segments.length; depth >= 0; depth--) {
    const dir = `/sys/fs/cgroup/${segments.slice(0, depth).join('/')}`.replace(/\/$/, '')
    const raw = fileReader(`${dir}/memory.max`)?.trim()
    if (raw && /^\d+$/.test(raw)) {
      return Math.round(Number(raw) / (1024 * 1024))
    }
  }
  return undefined
}

export function readLinuxOomKillCounters(): LinuxOomKillCounters | null {
  if (counterPlatform !== 'linux') {
    return null
  }
  const counters: LinuxOomKillCounters = {
    vmstatOomKill: keyedCounter(fileReader('/proc/vmstat'), 'oom_kill')
  }
  const cgroupPath = ownCgroupPath()
  if (cgroupPath) {
    const dir = `/sys/fs/cgroup${cgroupPath === '/' ? '' : cgroupPath}`
    counters.cgroupOomKill = keyedCounter(fileReader(`${dir}/memory.events`), 'oom_kill')
    counters.cgroupMemoryMaxMB = nearestMemoryMaxMB(cgroupPath)
  }
  const avg10 = fileReader('/proc/pressure/memory')?.match(/^some avg10=([\d.]+)/m)?.[1]
  if (avg10 !== undefined) {
    counters.memoryPressureSomeAvg10 = Number(avg10)
  }
  return counters
}

export type LinuxOomKillVerdict = 'orca-cgroup-oom-kill' | 'host-oom-kill' | 'no-kernel-oom-kill'

function counterDelta(before: number | undefined, after: number | undefined): number | undefined {
  return before === undefined || after === undefined ? undefined : Math.max(0, after - before)
}

function oomKillVerdict(
  vmstatDelta: number | undefined,
  cgroupDelta: number | undefined
): LinuxOomKillVerdict {
  // Why cgroup first: it counts only Orca's own processes, while a host kill may be anyone's.
  if ((cgroupDelta ?? 0) > 0) {
    return 'orca-cgroup-oom-kill'
  }
  return (vmstatDelta ?? 0) > 0 ? 'host-oom-kill' : 'no-kernel-oom-kill'
}

/**
 * Compares a reading taken before the death with one taken at process-gone.
 * The verdict is about kernel OOM activity in that window, not the exit cause:
 * read it beside `Reason: killed` / exit 9.
 */
export function linuxOomKillDetails(
  baseline: LinuxOomKillCounters,
  baselineAgeMs: number,
  current: LinuxOomKillCounters
): CrashReportDetails {
  const vmstatDelta = counterDelta(baseline.vmstatOomKill, current.vmstatOomKill)
  const cgroupDelta = counterDelta(baseline.cgroupOomKill, current.cgroupOomKill)
  if (vmstatDelta === undefined && cgroupDelta === undefined) {
    return {}
  }
  const details: CrashReportDetails = { linuxOomKillBaselineAgeMs: Math.max(0, baselineAgeMs) }
  if (vmstatDelta !== undefined) {
    details.linuxOomKillHostDelta = vmstatDelta
  }
  if (cgroupDelta !== undefined) {
    details.linuxOomKillCgroupDelta = cgroupDelta
  }
  details.linuxOomKillVerdict = oomKillVerdict(vmstatDelta, cgroupDelta)
  if (current.cgroupMemoryMaxMB !== undefined) {
    details.linuxCgroupMemoryMaxMB = current.cgroupMemoryMaxMB
  }
  // Why the baseline's PSI: the gone-time reading follows the kill that relieved the pressure.
  if (baseline.memoryPressureSomeAvg10 !== undefined) {
    details.linuxMemoryPressurePreGoneSomeAvg10 = baseline.memoryPressureSomeAvg10
  }
  return details
}
