import { Server } from 'lucide-react'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { NotificationSettingToggle } from './NotificationSettingToggle'
import { useNotificationHostOptions } from './use-notification-host-options'
import { translate } from '@/i18n/i18n'

type NotificationHostTogglesProps = {
  mutedExecutionHostIds: readonly ExecutionHostId[]
  disabled: boolean
  onChange: (hostId: ExecutionHostId, muted: boolean) => void
}

export function NotificationHostToggles({
  mutedExecutionHostIds,
  disabled,
  onChange
}: NotificationHostTogglesProps): React.JSX.Element | null {
  const hostOptions = useNotificationHostOptions()
  // Keep an effective mute reachable after the last remote machine is removed.
  if (
    !hostOptions.some((host) => host.id !== 'local') &&
    !hostOptions.some((host) => mutedExecutionHostIds.includes(host.id))
  ) {
    return null
  }
  return (
    <>
      <Separator />
      <div className="space-y-0.5 pt-2">
        <div className="flex items-center gap-2">
          <Server className="size-4" />
          <Label>
            {translate('auto.components.settings.NotificationHostToggles.machines', 'Machines')}
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.NotificationHostToggles.machinesDescription',
            'Show notifications from workspaces on each machine.'
          )}
        </p>
      </div>
      {hostOptions.map((host) => (
        <NotificationSettingToggle
          key={host.id}
          label={host.label}
          description={host.detail}
          checked={!mutedExecutionHostIds.includes(host.id)}
          disabled={disabled}
          onToggle={() => onChange(host.id, !mutedExecutionHostIds.includes(host.id))}
        />
      ))}
    </>
  )
}
