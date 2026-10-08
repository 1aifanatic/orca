/** Pinned-runtime refusals remembered in memory for this session, keyed by host and runtime. */
import { pinnedNodeRuntimeAsset, type NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import type { PinnedRuntimeRefusal } from './ssh-relay-runtime-self-test'

/**
 * Refusals the host can lose without Orca changing: a library installed, AV or application
 * control relaxed. They replay only briefly, never across restarts. POSIX noexec is left out:
 * rung C re-proves it, and D forgets a replayed one; Windows has neither, so there it expires too.
 */
const MUTABLE_PINNED_RUNTIME_REFUSALS: ReadonlySet<PinnedRuntimeRefusal> = new Set([
  'missing_lib',
  'security_software'
])
export const MUTABLE_PINNED_REFUSAL_REPLAY_MS = 10 * 60_000

export function isMutablePinnedRuntimeRefusal(
  refusal: PinnedRuntimeRefusal,
  target: NodeRuntimeTarget
): boolean {
  return (
    MUTABLE_PINNED_RUNTIME_REFUSALS.has(refusal) ||
    (refusal === 'noexec' && target.startsWith('win32-'))
  )
}

// Why also in memory: the persisted decision is written only once the ladder settles.
const refusals = new Map<string, { refusal: PinnedRuntimeRefusal; at: number }>()

function refusalKey(targetId: string, target: NodeRuntimeTarget): string {
  return `${targetId}\0${pinnedNodeRuntimeAsset(target).executableSha256}`
}

export function recordPinnedRuntimeRefusal(
  targetId: string,
  target: NodeRuntimeTarget,
  refusal: PinnedRuntimeRefusal
): void {
  refusals.set(refusalKey(targetId, target), { refusal, at: Date.now() })
}

export function rememberedPinnedRuntimeRefusal(
  targetId: string,
  target: NodeRuntimeTarget
): PinnedRuntimeRefusal | null {
  const key = refusalKey(targetId, target)
  const entry = refusals.get(key)
  if (!entry) {
    return null
  }
  if (
    isMutablePinnedRuntimeRefusal(entry.refusal, target) &&
    Date.now() - entry.at >= MUTABLE_PINNED_REFUSAL_REPLAY_MS
  ) {
    // Why: a repaired host must get rung A back on a later reconnect.
    refusals.delete(key)
    return null
  }
  return entry.refusal
}

/** Forgets a refusal a later rung has disproved, so the next connect retries rung A. */
export function forgetPinnedRuntimeRefusal(targetId: string, target: NodeRuntimeTarget): void {
  refusals.delete(refusalKey(targetId, target))
}

export function resetPinnedRuntimeRefusalsForTests(): void {
  refusals.clear()
}
