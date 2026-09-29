import { readFile } from 'node:fs/promises'
import { runProcess } from './child-process/run-process'
import type { AgentProcessIdentity, AgentProcessVerdict } from './agent-process-presence'

export type AgentProcessObservation =
  | { verdict: 'live'; startTime: string; zombie: boolean }
  | { verdict: 'unverifiable' | 'exited' }

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error.code === 'ESRCH' || error.code === 'ENOENT')
  )
}

export async function readAgentProcess(pid: number): Promise<AgentProcessObservation> {
  try {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch((error) => {
        if (isMissing(error)) {
          return null
        }
        throw error
      })
      if (stat === null) {
        return { verdict: 'exited' }
      }
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/)
      const boot = (
        await readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => '')
      ).trim()
      if (!/^\d+$/.test(fields[19] ?? '') || !boot) {
        return { verdict: 'unverifiable' }
      }
      return { verdict: 'live', startTime: `${boot}:${fields[19]}`, zombie: fields[0] === 'Z' }
    }
    if (process.platform === 'win32') {
      const { readWindowsProcessCreationTime } =
        await import('../main/windows/windows-process-table')
      const startTime = readWindowsProcessCreationTime(pid)
      if (startTime !== null) {
        return { verdict: 'live', startTime: String(startTime), zombie: false }
      }
      // A native null includes denied access and missing capability, not just absence.
      return { verdict: 'unverifiable' }
    }
    if (process.platform === 'darwin') {
      const result = await runProcess({
        program: '/bin/ps',
        args: ['-p', String(pid), '-o', 'stat=,lstart='],
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        timeoutMs: 1000,
        maxOutputBytes: 4096
      })
      if (!result.timedOut && result.code === 0) {
        const match = /^\s*(\S+)\s+(.+?)\s*$/.exec(result.stdout)
        if (match) {
          return { verdict: 'live', startTime: match[2], zombie: match[1].startsWith('Z') }
        }
      }
      try {
        process.kill(pid, 0)
      } catch (error) {
        if (isMissing(error)) {
          return { verdict: 'exited' }
        }
      }
    }
  } catch {
    return { verdict: 'unverifiable' }
  }
  return { verdict: 'unverifiable' }
}

export async function probeAgentProcessPresence(
  identity: AgentProcessIdentity | undefined,
  read: (pid: number) => Promise<AgentProcessObservation> = readAgentProcess,
  platform: NodeJS.Platform = process.platform
): Promise<AgentProcessVerdict> {
  if (!identity || identity.platform !== platform) {
    return 'unverifiable'
  }
  const observed = await read(identity.pid).catch(() => ({ verdict: 'unverifiable' as const }))
  if (observed.verdict !== 'live') {
    return observed.verdict
  }
  return observed.zombie || observed.startTime !== identity.startTime ? 'exited' : 'live'
}
