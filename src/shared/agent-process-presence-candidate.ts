import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import type { ForegroundAgentCandidate } from './foreground-wrapper-agent'

/** Presence belongs to the outer agent, even while one of its nested agents owns the foreground. */
export function selectDiscoveredAgentOwner(
  processId: number,
  candidates: readonly ForegroundAgentCandidate[]
): { processName: string; processId: number } | null {
  const byPid = new Map(candidates.map((candidate) => [candidate.pid, candidate]))
  let current = byPid.get(processId)
  let owner: { processName: string; processId: number } | null = null
  const seen = new Set<number>()
  while (current && !seen.has(current.pid)) {
    seen.add(current.pid)
    const recognized =
      recognizeAgentProcessFromCommandLine(current.command) ??
      recognizeAgentProcessFromCommandLine(current.name)
    if (recognized) {
      owner = { processName: recognized.processName, processId: current.pid }
    }
    current = byPid.get(current.ppid)
  }
  if (!owner || current) {
    return null
  }
  for (const candidate of candidates) {
    if (
      !recognizeAgentProcessFromCommandLine(candidate.command) &&
      !recognizeAgentProcessFromCommandLine(candidate.name)
    ) {
      continue
    }
    let ancestor: ForegroundAgentCandidate | undefined = candidate
    const visited = new Set<number>()
    while (ancestor && ancestor.pid !== owner.processId && !visited.has(ancestor.pid)) {
      visited.add(ancestor.pid)
      ancestor = byPid.get(ancestor.ppid)
    }
    if (ancestor?.pid !== owner.processId) {
      return null
    }
  }
  return owner
}

export function projectDiscoveredAgentOwner<T extends { processId?: number }>(
  identity: T,
  candidates: readonly ForegroundAgentCandidate[],
  capture: boolean | undefined
): T | { processName: string | null; processId?: number } {
  return capture && identity.processId !== undefined
    ? (selectDiscoveredAgentOwner(identity.processId, candidates) ?? { processName: null })
    : identity
}
