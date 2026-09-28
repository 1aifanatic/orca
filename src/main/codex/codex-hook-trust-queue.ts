import { dirname } from 'node:path'
import { withManagedHookInstallLock } from '../agent-hooks/managed-hook-install-lock'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import { getCodexConfigTomlPath, getSystemCodexConfigTomlPath } from './codex-hook-definition'
import { getSystemCodexHomePath } from './codex-home-paths'

// Why: every Orca on this HOME (dev, packaged, an offline CLI) writes the same
// ~/.codex files, and the in-process lane cannot keep another process out of a
// capture->restore window. Shares the relay installers' lock file for that home.
function withRealHomeWriteLock<R>(run: () => Promise<R>): Promise<R> {
  return withManagedHookInstallLock(dirname(getSystemCodexHomePath()), undefined, run)
}

/** The lane for every mutation of the user's real ~/.codex, across processes. */
export function runExclusivelyForSystemTrustConfig<T>(run: () => Promise<T>): Promise<T> {
  return runExclusivelyForCodexTrustConfig(
    getSystemCodexConfigTomlPath(),
    run,
    withRealHomeWriteLock
  )
}

// Why (#16441): these sequences mutate the runtime config.toml *and* the
// system one — approval promotion, the system-config sync and the legacy sweep
// all touch ~/.codex/config.toml — so holding only the runtime lane still lets
// a real-home grant's capture->restore window swallow their writes. Lock order
// is always runtime-before-system; every other holder acquires it that way too.
export function runExclusivelyForRuntimeAndSystemTrustConfig<T>(
  runtimeHomePath: string,
  run: () => Promise<T>
): Promise<T> {
  return runExclusivelyForCodexTrustConfig(getCodexConfigTomlPath(runtimeHomePath), () =>
    runExclusivelyForSystemTrustConfig(run)
  )
}
