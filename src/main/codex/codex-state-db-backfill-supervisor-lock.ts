import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { withManagedHookInstallLock } from '../agent-hooks/managed-hook-install-lock'
import { readManagedHookHostIdentity } from '../agent-hooks/managed-hook-owner-identity'
import { getOrcaUserDataPath } from './codex-home-paths'

// One Orca supervises a Codex home's backfill at a time, across Orca instances.

const RECOVERY_OWNER_CHECK_TIMEOUT_MS = 1_000

export function resolveCodexBackfillSupervisorLockRoot(codexHomePath: string): string {
  const homeKey = normalizeRuntimePathForComparison(codexHomePath)
  const digest = createHash('sha256').update(homeKey).digest('hex')
  return join(getOrcaUserDataPath(), 'codex-state-db-backfill-locks', digest)
}

function scopeRecoveryHostIdentity(hostIdentity: string, codexHomePath: string): string {
  const wslHome = process.platform === 'win32' ? parseWslUncPath(codexHomePath) : null
  return wslHome ? `${hostIdentity}:wsl:${wslHome.distro.toLowerCase()}` : hostIdentity
}

export async function withCodexBackfillSupervisorLock<T>(
  codexHomePath: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  const hostIdentity = scopeRecoveryHostIdentity(await readManagedHookHostIdentity(), codexHomePath)
  // Reuse the crash-safe hard-link claim protocol; its storage root is Codex-specific.
  return await withManagedHookInstallLock(
    resolveCodexBackfillSupervisorLockRoot(codexHomePath),
    signal,
    run,
    hostIdentity,
    { waitTimeoutMs: RECOVERY_OWNER_CHECK_TIMEOUT_MS }
  )
}
