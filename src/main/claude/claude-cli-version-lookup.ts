import { realpath, stat } from 'node:fs/promises'
import { probeClaudeCliVersion } from './claude-hook-event-versions'

/** Which binary a command is right now: a self-update swaps the link's target or the file. */
async function claudeBinaryIdentity(command: string): Promise<string | null> {
  try {
    const target = await realpath(command)
    return `${target}\n${(await stat(target)).mtimeMs}`
  } catch {
    return null
  }
}

const MAX_REMEMBERED_BINARIES = 8

export type ClaudeCliVersionLookup = (command: string) => Promise<string | null>

/** The version of the Claude binary a command names, probed once per binary. Only an answer is
 *  remembered: a probe that timed out or failed is asked again on the next launch. */
export function createClaudeCliVersionLookup(
  deps: {
    probe: (command: string) => Promise<string | null>
    identify: (command: string) => Promise<string | null>
  } = { probe: probeClaudeCliVersion, identify: claudeBinaryIdentity }
): ClaudeCliVersionLookup {
  const known = new Map<string, string>()
  const probing = new Map<string, Promise<string | null>>()
  return async (command) => {
    const identity = await deps.identify(command)
    if (identity === null) {
      return null
    }
    const remembered = known.get(identity)
    if (remembered !== undefined) {
      return remembered
    }
    let pending = probing.get(identity)
    if (!pending) {
      pending = deps.probe(command).finally(() => probing.delete(identity))
      probing.set(identity, pending)
    }
    const version = await pending
    if (version !== null) {
      known.set(identity, version)
      for (const stale of known.keys()) {
        if (known.size <= MAX_REMEMBERED_BINARIES) {
          break
        }
        known.delete(stale)
      }
    }
    return version
  }
}

/** One per process: every structured launch on this host shares what it learned. */
export const claudeCliVersionOf = createClaudeCliVersionLookup()
