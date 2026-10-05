import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT,
  takePendingReactErrorBoundaryReport
} from '@/lib/react-error-boundary-reporting'
import {
  useAutomaticPromptTurn,
  usePromptBlockingDialog
} from '@/components/automatic-prompts/use-automatic-prompt-turn'
import { AutomaticPromptDialogScope } from '@/lib/dialog-presence'
import { useAppStore } from '@/store'
import type { CrashReportRecord } from '../../../../shared/crash-reporting'

const CrashReportDialogSurface = lazy(() =>
  import('./CrashReportDialogSurface').then((module) => ({
    default: module.CrashReportDialogSurface
  }))
)

/** A report the app raises by itself, waiting for its turn among the other automatic prompts. */
type AutomaticCrashReport = {
  report: CrashReportRecord
  /** A launch report keeps its place; error-boundary reports not yet shown give way to a newer one. */
  origin: 'launch' | 'boundary'
  /** The launch prompt is one-shot: acknowledged once actually shown, never before. */
  acknowledgeOnShow: boolean
}

function shownAutomatically(reportId: string): boolean {
  return useAppStore
    .getState()
    .automaticPromptRequests.some(
      (request) => request.id === 'crash-report' && request.key === reportId && request.shown
    )
}

export function CrashReportDialog(): React.JSX.Element | null {
  const promptedThisLaunch = useRef(false)
  const acknowledgedIds = useRef(new Set<string>())
  const mountedRef = useMountedRef()
  // Help > Report Crash: the user asked, so it opens at once.
  const [userOpen, setUserOpen] = useState(false)
  const [userReport, setUserReport] = useState<CrashReportRecord | null>(null)
  const [loading, setLoading] = useState(false)
  // Each report the app raises by itself waits its own turn; a later one never replaces it.
  const [queue, setQueue] = useState<readonly AutomaticCrashReport[]>([])
  const automatic = queue[0] ?? null
  const [automaticVisible, markAutomaticShown] = useAutomaticPromptTurn(
    'crash-report',
    automatic !== null && !userOpen,
    automatic?.report.id
  )
  usePromptBlockingDialog('crash-report', userOpen)
  // Help > Report Crash over a report already on screen takes that same dialog over.
  const onScreenReportRef = useRef<CrashReportRecord | null>(null)
  useEffect(() => {
    onScreenReportRef.current = automaticVisible ? (automatic?.report ?? null) : null
  }, [automatic, automaticVisible])

  const raiseCrashReport = useCallback(
    (report: CrashReportRecord, origin: AutomaticCrashReport['origin']) => {
      setQueue((current) => {
        if (current.some((entry) => entry.report.id === report.id)) {
          return current
        }
        // One fault can trip several boundaries; like a dialog replacing its report, only the
        // newest of those not yet seen is offered.
        const kept =
          origin === 'boundary'
            ? current.filter(
                (entry) => entry.origin === 'launch' || shownAutomatically(entry.report.id)
              )
            : current
        const acknowledgeOnShow = origin === 'launch' && report.status === 'pending'
        return [...kept, { report, origin, acknowledgeOnShow }]
      })
    },
    []
  )

  const loadUserCrashReport = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const nextReport = await window.api.crashReports.getLatestReport()
      if (mountedRef.current) {
        setUserReport((current) => nextReport ?? current)
      }
    } catch (error) {
      console.error('Failed to load crash report:', error)
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [mountedRef])

  useEffect(() => {
    if (promptedThisLaunch.current) {
      return
    }
    promptedThisLaunch.current = true
    void window.api.crashReports
      .getLatestPending()
      .then((pending) => {
        if (pending && mountedRef.current) {
          raiseCrashReport(pending, 'launch')
        }
      })
      .catch((error) => console.error('Failed to load crash report:', error))
  }, [mountedRef, raiseCrashReport])

  // By id, not by who opened it: a send started before Help took the dialog over lands either way.
  const changeReport = useCallback((report: CrashReportRecord | null) => {
    if (!report) {
      return
    }
    setUserReport((current) => (current?.id === report.id ? report : current))
    setQueue((current) =>
      current.map((entry) => (entry.report.id === report.id ? { ...entry, report } : entry))
    )
  }, [])

  // Closing a report's dialog is done with that report, however it opened: one report, one dialog.
  const closeReport = useCallback((reportId: string | undefined) => {
    setUserOpen(false)
    if (reportId !== undefined) {
      setQueue((current) => current.filter((entry) => entry.report.id !== reportId))
    }
  }, [])

  // From the committed dialog content: the lazy surface may load well after the turn is granted.
  const onAutomaticShown = useCallback((): void => {
    markAutomaticShown()
    if (!automatic?.acknowledgeOnShow || acknowledgedIds.current.has(automatic.report.id)) {
      return
    }
    const { report } = automatic
    acknowledgedIds.current.add(report.id)
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
  }, [automatic, changeReport, markAutomaticShown, mountedRef])

  useEffect(() => {
    return window.api.ui.onOpenCrashReport(() => {
      setUserReport(onScreenReportRef.current)
      setUserOpen(true)
      void loadUserCrashReport()
    })
  }, [loadUserCrashReport])

  useEffect(() => {
    const pendingReport = takePendingReactErrorBoundaryReport()
    if (pendingReport) {
      raiseCrashReport(pendingReport, 'boundary')
    }

    const onReactErrorBoundaryReport = (): void => {
      const nextReport = takePendingReactErrorBoundaryReport()
      if (nextReport) {
        raiseCrashReport(nextReport, 'boundary')
      }
    }

    window.addEventListener(REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT, onReactErrorBoundaryReport)
    return () => {
      window.removeEventListener(
        REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT,
        onReactErrorBoundaryReport
      )
    }
  }, [raiseCrashReport])

  const open = userOpen || automaticVisible
  if (!open) {
    return null
  }
  const report = userOpen ? userReport : (automatic?.report ?? null)

  return (
    // Raised by itself, its own dialog never counts as another one and it steps aside under one;
    // opened from Help it is a user dialog like any other.
    <AutomaticPromptDialogScope automatic={!userOpen}>
      <Suspense fallback={null}>
        <CrashReportDialogSurface
          // One dialog per report: a new report starts fresh notes and viewer state, while Help over
          // the report on screen keeps them.
          key={report?.id ?? 'user'}
          open={open}
          report={report}
          loading={userOpen && loading && report === null}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              closeReport(report?.id)
            }
          }}
          onReportChange={changeReport}
          onShown={userOpen ? undefined : onAutomaticShown}
        />
      </Suspense>
    </AutomaticPromptDialogScope>
  )
}
