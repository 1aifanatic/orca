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
  const [automatic, setAutomatic] = useState<AutomaticCrashReport | null>(null)
  const automaticVisible = useAutomaticPromptTurn('crash-report', automatic !== null && !userOpen)
  usePromptBlockingDialog('crash-report', userOpen)

  const raiseCrashReport = useCallback((report: CrashReportRecord, acknowledgeOnShow = false) => {
    setAutomatic({ report, acknowledgeOnShow })
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

  useEffect(() => {
    if (!automaticVisible || !automatic?.acknowledgeOnShow) {
      return
    }
    const reportId = automatic.report.id
    if (acknowledgedIds.current.has(reportId)) {
      return
    }
    acknowledgedIds.current.add(reportId)
    // Why: startup crash prompts are one-shot. Acknowledged only once on screen, and never awaited:
    // a failed write must not delay the prompt, and the dialog dismisses a still-pending report on
    // close. Help > Report Crash can still reopen dismissed unsent reports.
    void window.api.crashReports
      .dismiss({ reportId })
      .then(() => {
        if (mountedRef.current) {
          setAutomatic((current) =>
            current?.report.id === reportId
              ? { ...current, report: { ...current.report, status: 'dismissed' as const } }
              : current
          )
        }
      })
      .catch((error) => {
        console.error('Failed to dismiss crash report after startup prompt:', error)
      })
  }, [automatic, automaticVisible, mountedRef])

  useEffect(() => {
    return window.api.ui.onOpenCrashReport(() => {
      // The user is now looking at crash reports; a queued one would only repeat what they see.
      setAutomatic(null)
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

  const changeAutomaticReport = useCallback((report: CrashReportRecord | null) => {
    setAutomatic((current) => (current && report ? { ...current, report } : current))
  }, [])

  const open = userOpen || automaticVisible
  if (!open) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <CrashReportDialogSurface
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
            setAutomatic(null)
          }
        }}
        onReportChange={userOpen ? setUserReport : changeAutomaticReport}
      />
    </Suspense>
  )
}
