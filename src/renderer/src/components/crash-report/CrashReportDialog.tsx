import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT,
  takePendingReactErrorBoundaryReports
} from '@/lib/react-error-boundary-reporting'
import { AdoptDialogEntry, useHostDialogEntry } from '@/lib/dialog-registry-entry'
import { useDialogRegistry } from '@/store/dialog-registry'
import { selectAdmittedDialog, type StartupSourceAnswer } from '@/store/dialog-registry-state'
import { useCrashReportSends } from './use-crash-report-sends'
import type { CrashReportRecord } from '../../../../shared/crash-reporting'

const CrashReportDialogSurface = lazy(() =>
  import('./CrashReportDialogSurface').then((module) => ({
    default: module.CrashReportDialogSurface
  }))
)

/** Help > Report Crash's own entry. */
const USER_DIALOG_TOKEN = 'crash-report-dialog:user'

function crashReportToken(reportId: string): string {
  return `crash-report:${reportId}`
}

/** A report the app raises by itself. Each takes its own turn; a later one never replaces it. */
type AutomaticCrashReport = {
  report: CrashReportRecord
  /** The launch prompt is one-shot: acknowledged once on screen, never before. */
  acknowledgeOnShow: boolean
  /** Still wanted; a closed one is kept only so its dialog can finish closing. */
  open: boolean
}

/** Help > Report Crash, opened over no report: the latest one, once loaded. */
type UserDialog = { report: CrashReportRecord | null }

export function CrashReportDialog(): React.JSX.Element | null {
  const promptedThisLaunch = useRef(false)
  const acknowledgedTokens = useRef(new Set<string>())
  const mountedRef = useMountedRef()
  const [userDialog, setUserDialog] = useState<UserDialog | null>(null)
  const [loading, setLoading] = useState(false)
  const [reports, setReports] = useState<ReadonlyMap<string, AutomaticCrashReport>>(() => new Map())
  const [launchAnswer, setLaunchAnswer] = useState<Exclude<StartupSourceAnswer, 'pending'> | null>(
    null
  )
  const admitted = useDialogRegistry((s) => selectAdmittedDialog(s, 'crash-report'))
  const admittedReport = admitted ? reports.get(admitted.token) : undefined
  useHostDialogEntry(USER_DIALOG_TOKEN, 'dialog', 'user', userDialog !== null)

  const reportsRef = useRef(reports)
  // The registry follows this list: queued while open, closed once done. The launch check answers
  // only after its report is queued, so no later dialog can take the turn in between.
  useLayoutEffect(() => {
    reportsRef.current = reports
    const registry = useDialogRegistry.getState()
    for (const [token, entry] of reports) {
      if (entry.open) {
        registry.enqueueAutomaticDialog(token, 'crash-report')
      } else {
        registry.closeDialog(token)
      }
    }
    if (launchAnswer !== null) {
      registry.settleStartupSource('crash-report', launchAnswer)
    }
  }, [launchAnswer, reports])
  // Gone, this owner withdraws its reports.
  useLayoutEffect(
    () => () => {
      for (const token of reportsRef.current.keys()) {
        useDialogRegistry.getState().closeDialog(token)
      }
    },
    []
  )

  const raiseCrashReport = useCallback((report: CrashReportRecord, acknowledgeOnShow: boolean) => {
    const token = crashReportToken(report.id)
    // The same report again is the same dialog; any other report is queued after it.
    setReports((current) =>
      current.get(token)?.open
        ? current
        : new Map(current).set(token, { report, acknowledgeOnShow, open: true })
    )
  }, [])

  // By id, not by who opened it: a send started before Help took the dialog over lands either way.
  const changeReport = useCallback((report: CrashReportRecord | null) => {
    if (!report) {
      return
    }
    const token = crashReportToken(report.id)
    setUserDialog((current) =>
      current?.report?.id === report.id ? { ...current, report } : current
    )
    setReports((current) => {
      const entry = current.get(token)
      return entry ? new Map(current).set(token, { ...entry, report }) : current
    })
  }, [])

  // Done with a report however it opened: one report, one dialog.
  const closeReport = useCallback((reportId: string | null) => {
    if (reportId === null) {
      return
    }
    const token = crashReportToken(reportId)
    setReports((current) => {
      const entry = current.get(token)
      return entry?.open ? new Map(current).set(token, { ...entry, open: false }) : current
    })
  }, [])

  const { send, isSending } = useCrashReportSends(
    useCallback(
      (reportId: string | null, sent: CrashReportRecord | null) => {
        changeReport(sent)
        // A dialog showing another report stays open.
        setUserDialog((current) => ((current?.report?.id ?? null) === reportId ? null : current))
        closeReport(reportId)
      },
      [changeReport, closeReport]
    )
  )

  useEffect(() => {
    if (promptedThisLaunch.current) {
      return
    }
    promptedThisLaunch.current = true
    void window.api.crashReports.getLatestPending().then(
      (pending) => {
        if (!mountedRef.current) {
          // No owner left to show it; later dialogs must not wait on it.
          useDialogRegistry.getState().settleStartupSource('crash-report', 'unavailable')
          return
        }
        if (pending) {
          raiseCrashReport(pending, pending.status === 'pending')
        }
        setLaunchAnswer(pending ? 'ready' : 'none')
      },
      (error) => {
        console.error('Failed to load crash report:', error)
        useDialogRegistry.getState().settleStartupSource('crash-report', 'unavailable')
      }
    )
  }, [mountedRef, raiseCrashReport])

  useEffect(() => {
    const raisePending = (): void => {
      for (const report of takePendingReactErrorBoundaryReports()) {
        raiseCrashReport(report, false)
      }
    }
    raisePending()
    window.addEventListener(REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT, raisePending)
    return () =>
      window.removeEventListener(REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT, raisePending)
  }, [raiseCrashReport])

  // From the committed content: the lazy surface may load well after the turn is granted.
  const visibleToken = admitted?.phase === 'visible' ? admitted.token : null
  useEffect(() => {
    const entry = visibleToken === null ? undefined : reports.get(visibleToken)
    if (visibleToken === null || !entry?.acknowledgeOnShow) {
      return
    }
    if (acknowledgedTokens.current.has(visibleToken)) {
      return
    }
    acknowledgedTokens.current.add(visibleToken)
    const { report } = entry
    // Why: startup crash prompts are one-shot. Never awaited: a failed write must not hold the
    // prompt back, and the dialog dismisses a still-pending report on close. Help > Report Crash
    // can still reopen dismissed unsent reports.
    void window.api.crashReports
      .dismiss({ reportId: report.id })
      .then(() => {
        if (mountedRef.current) {
          changeReport({ ...report, status: 'dismissed' as const })
        }
      })
      .catch((error) => {
        console.error('Failed to dismiss crash report after startup prompt:', error)
      })
  }, [changeReport, mountedRef, reports, visibleToken])

  const loadUserCrashReport = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const latest = await window.api.crashReports.getLatestReport()
      if (mountedRef.current && latest) {
        // Only into a dialog still waiting for one; a report already shown is never swapped.
        setUserDialog((current) =>
          current && current.report === null ? { report: latest } : current
        )
      }
    } catch (error) {
      console.error('Failed to load crash report:', error)
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [mountedRef])

  const reportOnScreen = admitted !== undefined && admitted.phase !== 'closing'
  useEffect(() => {
    return window.api.ui.onOpenCrashReport(() => {
      // A report dialog already up is the one Help would show: it stays as it is, notes and all.
      if (userDialog !== null || reportOnScreen) {
        return
      }
      setUserDialog({ report: null })
      void loadUserCrashReport()
    })
  }, [loadUserCrashReport, reportOnScreen, userDialog])

  if (userDialog === null && !admittedReport) {
    return null
  }
  const report = userDialog ? userDialog.report : (admittedReport?.report ?? null)
  const surfaceKey = userDialog ? USER_DIALOG_TOKEN : admitted?.token
  const open = userDialog !== null || admitted?.phase !== 'closing'

  return (
    <AdoptDialogEntry token={userDialog ? USER_DIALOG_TOKEN : (admitted?.token ?? null)}>
      <Suspense fallback={null}>
        <CrashReportDialogSurface
          key={surfaceKey}
          open={open}
          report={report}
          loading={loading && report === null}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setUserDialog(null)
              closeReport(report?.id ?? null)
            }
          }}
          onReportChange={changeReport}
          submitting={isSending(report)}
          onSubmit={(request) => send(report, request)}
        />
      </Suspense>
    </AdoptDialogEntry>
  )
}
