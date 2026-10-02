import { Server } from 'lucide-react'
import type { NotificationSourceId } from '../../../../shared/notification-source'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { NotificationSettingToggle } from './NotificationSettingToggle'
import { useNotificationSourceOptions } from './use-notification-source-options'
import { translate } from '@/i18n/i18n'

type NotificationHostTogglesProps = {
  mutedNotificationSourceIds: readonly NotificationSourceId[]
  disabled: boolean
  onChange: (hostId: NotificationSourceId, muted: boolean) => void
}

export function NotificationHostToggles({
  mutedNotificationSourceIds,
  disabled,
  onChange
}: NotificationHostTogglesProps): React.JSX.Element | null {
  const hostOptions = useNotificationSourceOptions()
  // Keep an effective mute reachable after the last remote machine is removed.
  if (
    !hostOptions.some((host) => host.id !== 'local') &&
    !hostOptions.some((host) => mutedNotificationSourceIds.includes(host.id))
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
            'Show notifications from each connected machine. A paired server’s switch also covers work reached through it.'
          )}
        </p>
      </div>
      {hostOptions.map((host) => (
        <NotificationSettingToggle
          key={host.id}
          label={host.label}
          description={host.detail}
          checked={!mutedNotificationSourceIds.includes(host.id)}
          disabled={disabled}
          onToggle={() => onChange(host.id, !mutedNotificationSourceIds.includes(host.id))}
        />
      ))}
    </>
  )
}
