import { Globe, Loader2, ServerOff } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  ReopenBrowserPageOnServerButton,
  reopenOnServerCaveat
} from './ReopenBrowserPageOnServerButton'
import { readBrowserClientHostId } from '@/runtime/browser-client-host-identity'
import {
  requestClientHostedBrowserReconnect,
  useClientHostedBrowserHostReachability
} from './use-client-hosted-browser-host-reachability'

/**
 * Says why a client-hosted page is not serving: its host is offline (a strip over a still-live page,
 * or a notice once the guest is gone), or the guest is gone for another reason.
 */
export function ClientHostedBrowserAvailabilityNotice({
  runtimeEnvironmentId,
  worktreeId,
  lastCommittedUrl,
  guestUnavailable,
  browserHostClientId,
  isActive
}: {
  runtimeEnvironmentId: string
  worktreeId: string
  lastCommittedUrl: string
  guestUnavailable: boolean
  browserHostClientId: string | null
  isActive: boolean
}): React.JSX.Element | null {
  const { hostOffline, hostName } = useClientHostedBrowserHostReachability({
    runtimeEnvironmentId,
    isActive
  })
  if (guestUnavailable) {
    return (
      <ClientHostedBrowserUnavailableNotice
        runtimeEnvironmentId={runtimeEnvironmentId}
        worktreeId={worktreeId}
        lastCommittedUrl={lastCommittedUrl}
        reason={
          hostOffline
            ? 'host-offline'
            : browserHostClientId !== null && browserHostClientId !== readBrowserClientHostId()
              ? 'other-desktop'
              : 'unavailable'
        }
        hostName={hostName}
      />
    )
  }
  return hostOffline ? (
    <ClientHostedBrowserHostOfflineStrip
      runtimeEnvironmentId={runtimeEnvironmentId}
      hostName={hostName}
    />
  ) : null
}

/**
 * What a client-hosted page shows when its guest is not here. The reason decides the copy: a host
 * that is merely offline is waited for, never presented as an error, and "another desktop" is only
 * said when the placement actually names one.
 */
export function ClientHostedBrowserUnavailableNotice({
  runtimeEnvironmentId,
  worktreeId,
  lastCommittedUrl,
  reason,
  hostName
}: {
  runtimeEnvironmentId: string
  worktreeId: string
  lastCommittedUrl: string
  reason: 'host-offline' | 'other-desktop' | 'unavailable'
  hostName: string | null
}): React.JSX.Element {
  if (reason === 'host-offline') {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-background px-6 text-center">
        <div className="flex max-w-sm flex-col items-center gap-2">
          <ServerOff className="size-5 text-muted-foreground" />
          <div className="text-sm font-medium text-foreground">{hostOfflineTitle(hostName)}</div>
          <div className="text-xs leading-5 text-muted-foreground">
            {translate(
              'browser.clientHosted.hostOfflineDescription',
              'Reconnecting. This page comes back when the host is reachable again.'
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => requestClientHostedBrowserReconnect(runtimeEnvironmentId)}
          >
            {translate('browser.clientHosted.reconnectNow', 'Reconnect now')}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-2">
        <Globe className="size-5 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">
          {translate('browser.clientHosted.unavailableTitle', 'Client-hosted browser unavailable')}
        </div>
        <div className="text-xs leading-5 text-muted-foreground">
          {reason === 'other-desktop'
            ? translate(
                'browser.clientHosted.otherDesktopDescription',
                'This page is open on a different desktop.'
              )
            : translate(
                'browser.clientHosted.noLongerAvailableDescription',
                'This page is no longer available on this desktop.'
              )}
        </div>
        <div className="text-xs leading-5 text-muted-foreground">{reopenOnServerCaveat()}</div>
        <ReopenBrowserPageOnServerButton
          environmentId={runtimeEnvironmentId}
          worktreeId={worktreeId}
          lastCommittedUrl={lastCommittedUrl}
        />
      </div>
    </div>
  )
}

/** Sits over a live page while its host is unreachable: the page stays, its network does not. */
function ClientHostedBrowserHostOfflineStrip({
  runtimeEnvironmentId,
  hostName
}: {
  runtimeEnvironmentId: string
  hostName: string | null
}): React.JSX.Element {
  return (
    <div
      role="status"
      className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground"
    >
      <Loader2 className="size-3.5 shrink-0 animate-spin" />
      <span className="min-w-0 flex-1 truncate">
        {hostOfflineTitle(hostName)}
        {' — '}
        {translate('browser.clientHosted.reconnecting', 'reconnecting')}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => requestClientHostedBrowserReconnect(runtimeEnvironmentId)}
      >
        {translate('browser.clientHosted.reconnectNow', 'Reconnect now')}
      </Button>
    </div>
  )
}

function hostOfflineTitle(hostName: string | null): string {
  return hostName
    ? translate('browser.clientHosted.hostOfflineNamed', '{{host}} is offline', { host: hostName })
    : translate('browser.clientHosted.hostOffline', 'The host is offline')
}
