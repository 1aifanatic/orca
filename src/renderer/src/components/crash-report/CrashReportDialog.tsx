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
import type { CrashReportRecord } from '../../../../shared/crash-reporting'

const CrashReportDialogSurface = lazy(() =>
  import('./CrashReportDialogSurface').then((module) => ({
    default: module.CrashReportDialogSurface
  }))
)

/** A report the app raises by itself, waiting for its turn among the other automatic prompts. */
type AutomaticCrashReport = {
  report: CrashReportRecord
  /** The launch prompt is one-shot: acknowledged once actually shown, never before. */
  acknowledgeOnShow: boolean
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

  const raiseCrashReport = useCallback((report: CrashReportRecord, acknowledgeOnShow = false) => {
    setQueue((current) =>
      current.some((entry) => entry.report.id === report.id)
        ? current
        : [...current, { report, acknowledgeOnShow }]
    )
  }, [])

  const loadUserCrashReport = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const nextReport = await window.api.crashReports.getLatestReport()
      if (mountedRef.current) {
        setUserReport(nextReport)
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
          raiseCrashReport(pending, pending.status === 'pending')
        }
      })
      .catch((error) => console.error('Failed to load crash report:', error))
  }, [mountedRef, raiseCrashReport])

  const changeAutomaticReport = useCallback((report: CrashReportRecord | null) => {
    if (report) {
      setQueue((current) =>
        current.map((entry) => (entry.report.id === report.id ? { ...entry, report } : entry))
      )
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
          changeAutomaticReport({ ...report, status: 'dismissed' as const })
        }
      })
      .catch((error) => {
        console.error('Failed to dismiss crash report after startup prompt:', error)
      })
  }, [automatic, changeAutomaticReport, markAutomaticShown, mountedRef])

  useEffect(() => {
    return window.api.ui.onOpenCrashReport(() => {
      setUserReport(null)
      setUserOpen(true)
      void loadUserCrashReport()
    })
  }, [loadUserCrashReport])

  useEffect(() => {
    const pendingReport = takePendingReactErrorBoundaryReport()
    if (pendingReport) {
      raiseCrashReport(pendingReport)
    }

    const onReactErrorBoundaryReport = (): void => {
      const nextReport = takePendingReactErrorBoundaryReport()
      if (nextReport) {
        raiseCrashReport(nextReport)
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

  return (
    // Its own dialog never counts as another one it waits for.
    <AutomaticPromptDialogScope.Provider value>
      <Suspense fallback={null}>
        <CrashReportDialogSurface
          // A new report is a new dialog, so its notes and viewer state start fresh.
          key={userOpen ? 'user' : automatic?.report.id}
          open={open}
          report={userOpen ? userReport : (automatic?.report ?? null)}
          loading={userOpen && loading}
          onOpenChange={(nextOpen) => {
            if (nextOpen) {
              return
            }
            if (userOpen) {
              setUserOpen(false)
            } else {
              setQueue((current) => current.slice(1))
            }
          }}
          onReportChange={userOpen ? setUserReport : changeAutomaticReport}
          onShown={userOpen ? undefined : onAutomaticShown}
        />
      </Suspense>
    </AutomaticPromptDialogScope.Provider>
  )
}
