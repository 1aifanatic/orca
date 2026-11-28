import type { DesktopCore } from './desktop-core'
import { awaitPackedRefsLockRelease } from '../git/refs/maintenance/local-repo-ref-maintenance'
import { cancelHistoryGc } from '../pty/history/terminal-history-gc'
import { fenceMainProcessCloudOnQuit } from '../startup/cloud-startup/main-process-connector-startup'
import { flushUnsavedCloudSessions } from '../orca-profiles/cloud-session/profile-cloud-session-owner'

/** Before-quit: fence new work while a renderer can still veto. `releaseAgentAwake` keeps its place. */
export function fenceDesktopCore(core: DesktopCore, releaseAgentAwake: () => void): void {
  flushUnsavedCloudSessions()
  fenceMainProcessCloudOnQuit()
  core.runtimeRpc?.setMobileRelayPairingProvider(null)
  core.uninstallHookStatusRepublish?.()
  core.uninstallHookStatusRepublish = null
  releaseAgentAwake()
  // Beforeunload may veto; wait for ref locks now but uninstall only after committed quit. isQuitting already blocks new attempts.
  core.repoMaintenanceShutdown = awaitPackedRefsLockRelease()
  // Delay PTY cleanup until scrollback capture; exit events otherwise unmount the renderer callbacks.
  core.rateLimits?.stop()
  // History GC is idempotent and rescheduled next launch; a vetoed quit costs only a deferred sweep.
  cancelHistoryGc()
}
