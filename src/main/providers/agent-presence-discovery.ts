import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { AgentProcessPresence } from '../../shared/agent-process-presence'
import { resolveAgentForegroundProcessWithAvailability } from './agent-foreground-process'
import { readHostAgentProcess } from './agent-process-presence-probe'

export async function discoverLocalAgentPresence(
  rootProcessId: number
): Promise<AgentProcessPresence | undefined> {
  const platform = process.platform
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    return undefined
  }
  const candidate = await resolveAgentForegroundProcessWithAvailability(
    rootProcessId,
    platform === 'win32' ? 'cmd.exe' : 'sh',
    {
      capturePresence: true,
      fresh: true,
      forceProcessScan: true
    }
  )
  const agent = recognizeAgentProcess(candidate.processName)?.agent
  if (!candidate.available || !candidate.processId || !agent) {
    return undefined
  }
  const birth = await readHostAgentProcess(candidate.processId)
  if (birth.verdict !== 'live' || birth.zombie || birth.stopped) {
    return undefined
  }
  const confirmed = await resolveAgentForegroundProcessWithAvailability(
    rootProcessId,
    platform === 'win32' ? 'cmd.exe' : 'sh',
    {
      capturePresence: true,
      fresh: true,
      forceProcessScan: true
    }
  )
  if (
    !confirmed.available ||
    confirmed.processId !== candidate.processId ||
    recognizeAgentProcess(confirmed.processName)?.agent !== agent
  ) {
    return undefined
  }
  const finalBirth = await readHostAgentProcess(candidate.processId)
  if (
    finalBirth.verdict !== 'live' ||
    finalBirth.startTime !== birth.startTime ||
    finalBirth.zombie ||
    finalBirth.stopped
  ) {
    return undefined
  }
  return { agent, process: { pid: candidate.processId, platform, startTime: birth.startTime } }
}
