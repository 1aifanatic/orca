export type AgentProcessIdentity = {
  pid: number
  platform: 'darwin' | 'linux' | 'win32'
  startTime: string
}

/** The pane's agent process, owned from its first identified hook until it ends. */
export type AgentProcessPresence = {
  process: AgentProcessIdentity
  ended?: true
}

export type AgentProcessVerdict = 'live' | 'unverifiable' | 'exited'

export function readAgentProcessIdentity(value: unknown): AgentProcessIdentity | undefined {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object') {
    return undefined
  }
  if (!('pid' in value) || !('platform' in value) || !('startTime' in value)) {
    return undefined
  }
  const { pid, platform, startTime } = value
  if (
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    pid > 0xffffffff ||
    (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') ||
    typeof startTime !== 'string' ||
    startTime.length === 0 ||
    startTime.length > 160
  ) {
    return undefined
  }
  return { pid, platform, startTime }
}

export function readAgentProcessPresence(value: unknown): AgentProcessPresence | undefined {
  if (!value || typeof value !== 'object' || !('process' in value)) {
    return undefined
  }
  const process = readAgentProcessIdentity(value.process)
  if (!process) {
    return undefined
  }
  return {
    process,
    ...('ended' in value && value.ended === true ? { ended: true as const } : {})
  }
}

export function isSameAgentProcess(a: AgentProcessIdentity, b: AgentProcessIdentity): boolean {
  return a.pid === b.pid && a.platform === b.platform && a.startTime === b.startTime
}
