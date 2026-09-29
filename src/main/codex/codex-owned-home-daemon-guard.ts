import { join } from 'node:path'
import { writeFileAtomicallyIfUnchanged } from '../codex-accounts/fs-utils'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { observeAgentStateFile } from './codex-path-observation'
import { getSystemCodexHomePath } from './codex-home-paths'
import { applyCodexDaemonSocketGuard } from './codex-daemon-socket-path-guard'

const refusedUserHomeTargets = new Set<string>()

/** True (and logged once) when a caller hands over the user's own home as the Orca-owned target. */
export function refuseUserCodexHomeAsTarget(
  runtimeHomePath: string,
  systemHomePath: string
): boolean {
  // Why: spellings differ (\\wsl$ vs \\wsl.localhost, distro casing), so a plain === is not enough.
  const target = normalizeRuntimePathForComparison(runtimeHomePath)
  if (target !== normalizeRuntimePathForComparison(systemHomePath)) {
    return false
  }
  if (!refusedUserHomeTargets.has(target)) {
    refusedUserHomeTargets.add(target)
    console.warn(
      `[codex-config] Refusing to write Orca's managed Codex config into ${runtimeHomePath}: it is the user's own Codex home.`
    )
  }
  return true
}

/** Applies only the daemon guard, for passes that have no source config to mirror. */
export function ensureCodexDaemonSocketGuard(
  runtimeHomePath: string,
  systemHomePath: string = getSystemCodexHomePath()
): void {
  if (refuseUserCodexHomeAsTarget(runtimeHomePath, systemHomePath)) {
    return
  }
  try {
    const observation = observeAgentStateFile(join(runtimeHomePath, 'config.toml'))
    if (observation.kind !== 'indeterminate') {
      writeCodexDaemonSocketGuard(
        runtimeHomePath,
        observation.kind === 'present' ? observation.value : null
      )
    }
  } catch (error) {
    console.warn('[codex-config] Failed to apply the Codex daemon socket guard:', error)
  }
}

export function writeCodexDaemonSocketGuard(
  runtimeHomePath: string,
  runtimeConfig: string | null
): void {
  const guarded = applyCodexDaemonSocketGuard(runtimeConfig ?? '', runtimeHomePath)
  if (guarded !== (runtimeConfig ?? '')) {
    writeFileAtomicallyIfUnchanged(join(runtimeHomePath, 'config.toml'), runtimeConfig, guarded)
  }
}
