import type { ReactNode } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { StatusBarUsageChangeNoticeCard } from './StatusBarUsageChangeNoticeCard'
import { UsagePercentageDisplayChangeNotice } from './UsagePercentageDisplayChangeNotice'

export function StatusBarUsageChangeNotices({
  children,
  hasVisibleUsageMeters
}: {
  children: ReactNode
  hasVisibleUsageMeters: boolean
}): React.JSX.Element {
  const ready = useAppStore((s) => s.persistedUIReady)
  const dismissed = useAppStore((s) => s.statusBarCompactChangeNoticeDismissed)
  const dismiss = useAppStore((s) => s.dismissStatusBarCompactChangeNotice)
  const mode = useAppStore((s) => s.statusBarUsageMode)
  const visible = useAppStore((s) => s.statusBarVisible)
  const modal = useAppStore((s) => s.activeModal)

  if (dismissed || mode !== 'compact') {
    return (
      <UsagePercentageDisplayChangeNotice hasVisibleUsageMeters={hasVisibleUsageMeters}>
        {children}
      </UsagePercentageDisplayChangeNotice>
    )
  }

  return (
    <StatusBarUsageChangeNoticeCard
      eligible={ready && visible && hasVisibleUsageMeters && modal === 'none'}
      dismiss={dismiss}
      title={translate(
        'auto.components.status.bar.StatusBarUsageChangeNotices.compactTitle',
        'Usage is now compact'
      )}
      description={translate(
        'auto.components.status.bar.StatusBarUsageChangeNotices.compactBody',
        'One headline metric per provider. Choose Detailed in the Usage menu to show more limits.'
      )}
    >
      {children}
    </StatusBarUsageChangeNoticeCard>
  )
}
