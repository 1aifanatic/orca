export type AgentProcessIdentity = {
  pid: number
  platform: 'darwin' | 'linux' | 'win32'
  startTime: string
}

/** Hook presence is independent of whether the last turn finished. */
export type AgentProcessPresence = {
  sessionId: string
  process?: AgentProcessIdentity
  ended?: true
  sessionSwitch?: true
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
  if (
    !value ||
    typeof value !== 'object' ||
    !('sessionId' in value) ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId ||
    value.sessionId.length > 512
  ) {
    return undefined
  }
  return {
    sessionId: value.sessionId,
    process: 'process' in value ? readAgentProcessIdentity(value.process) : undefined,
    ...('ended' in value && value.ended === true ? { ended: true as const } : {}),
    ...('sessionSwitch' in value && value.sessionSwitch === true
      ? { sessionSwitch: true as const }
      : {})
  }
}
