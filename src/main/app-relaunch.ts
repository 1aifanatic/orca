import { app } from 'electron'
import type { CrashReportBreadcrumbData } from '../shared/crash-reporting'
import { recordDurableCrashBreadcrumb } from './crash-reporting/durable-crash-breadcrumb'
import { recordMainSessionExitSync } from './crash-reporting/main-session-exit-marker'
import { runWithLaunchPath } from './startup/hydrate-shell-path'

export type AppRelaunchReason =
  | 'admin-restart'
  | 'gpu-fallback'
  | 'profile-switch'
  | 'profile-transfer'
  | 'renderer-request'

export function relaunchApp(reason: AppRelaunchReason, data?: CrashReportBreadcrumbData): void {
  // Why: the current process can exit immediately after app.relaunch(), so
  // persist the cause before Electron schedules the replacement process.
  recordDurableCrashBreadcrumb('app_relaunch_requested', { ...data, reason })
  // Why sync: most callers app.exit(0) next, which skips will-quit and any pending write.
  recordMainSessionExitSync('relaunch')
  runWithLaunchPath(() => app.relaunch())
}
