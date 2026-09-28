import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname } from 'node:path'
import { withManagedHookInstallLock } from '../agent-hooks/managed-hook-install-lock'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import { getCodexConfigTomlPath, getSystemCodexConfigTomlPath } from './codex-hook-definition'
import { getSystemCodexHomePath } from './codex-home-paths'

const realHomeWriteLockHeld = new AsyncLocalStorage<true>()

/**
 * Holds the cross-process lock every Orca on this HOME shares for writes to the
 * real ~/.codex and ~/.orca/agent-hooks. Callers compare first and take it only
 * when a write is needed, then re-read and recheck under it: the steady-state
 * pane spawn writes nothing, so it must pay neither the owner probe nor a wait
 * behind another instance's trust session.
 */
export function withRealHomeWriteLock<R>(run: () => Promise<R>): Promise<R> {
  if (realHomeWriteLockHeld.getStore()) {
    // Why: the lock file is not reentrant; grants and rebases nest inside an install.
    return run()
  }
  return withManagedHookInstallLock(dirname(getSystemCodexHomePath()), undefined, () =>
    realHomeWriteLockHeld.run(true, run)
  )
}

/** The in-process lane for every mutation of the user's real ~/.codex/config.toml. */
export function runExclusivelyForSystemTrustConfig<T>(run: () => Promise<T>): Promise<T> {
  return runExclusivelyForCodexTrustConfig(getSystemCodexConfigTomlPath(), run)
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
