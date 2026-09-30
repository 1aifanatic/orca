import { setCrashBreadcrumbRecordedListener } from './crash-breadcrumb-store'
import { getPreviousSessionCrashpadDump } from './crashpad-capture'
import { recordDurableCrashBreadcrumb } from './durable-crash-breadcrumb'
import { getMainProcessLifecycleIdentity } from './main-process-lifecycle-identity'
import {
  beginMainSessionTracking,
  buildUncleanMainExitBreadcrumbData,
  noteMainSessionActivity,
  type PreviousUncleanMainSession
} from './main-session-exit-marker'

let pendingReport: PreviousUncleanMainSession | null = null

/** Call after the single-instance lock and before startCrashpadCapture. */
export function startMainSessionExitTracking(
  userDataPath: string,
  appVersion: string
): PreviousUncleanMainSession | null {
  pendingReport = beginMainSessionTracking({
    userDataPath,
    identity: getMainProcessLifecycleIdentity(),
    appVersion
  })
  setCrashBreadcrumbRecordedListener(noteMainSessionActivity)
  return pendingReport
}

/** Call once observability is up so the breadcrumb reaches the diagnostic log. */
export async function reportPreviousUncleanMainExit(): Promise<void> {
  const previous = pendingReport
  pendingReport = null
  if (!previous) {
    return
  }
  const dump = await getPreviousSessionCrashpadDump()
  recordDurableCrashBreadcrumb(
    'main_previous_session_unclean_exit',
    buildUncleanMainExitBreadcrumbData(previous, dump)
  )
}
