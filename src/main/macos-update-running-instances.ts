import path from 'node:path'
import { runProcess } from '../shared/child-process/run-process'

/** Squirrel waits for every main application process from the target bundle. */
export async function getMacUpdateRunningInstances(
  executable = process.execPath,
  currentPid = process.pid
): Promise<number[]> {
  if (process.platform !== 'darwin' || !executable.includes('.app/Contents/MacOS/')) {
    return []
  }
  const result = await runProcess({
    program: '/bin/ps',
    args: ['-U', String(process.getuid?.()), '-ww', '-o', 'pid=,comm='],
    timeoutMs: 5_000,
    maxOutputBytes: 2 * 1024 * 1024,
    killOnOutputLimit: true
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error('Could not check running Orca instances')
  }
  return parseMacUpdateRunningInstances(result.stdout, executable, currentPid)
}

export function parseMacUpdateRunningInstances(
  listing: string,
  executable: string,
  currentPid: number
): number[] {
  const pids: number[] = []
  for (const line of listing.split('\n')) {
    if (!line.trim()) {
      continue
    }
    const row = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!row) {
      throw new Error('Invalid macOS process listing')
    }
    const pid = Number(row[1])
    if (pid !== currentPid && path.normalize(row[2]) === path.normalize(executable)) {
      pids.push(pid)
    }
  }
  return pids
}
