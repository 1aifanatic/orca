import { Server } from 'lucide-react'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { NotificationSettingToggle } from './NotificationSettingToggle'
import { useSidebarHostScopeOptions } from '../sidebar/use-sidebar-host-scope-options'
import { shouldShowHostScopeControls } from '../sidebar/sidebar-host-options'
import { translate } from '@/i18n/i18n'

export function toggleMutedExecutionHost(
  muted: readonly ExecutionHostId[],
  hostId: ExecutionHostId
): ExecutionHostId[] {
  return muted.includes(hostId) ? muted.filter((id) => id !== hostId) : [...muted, hostId]
}

type NotificationHostTogglesProps = {
  mutedExecutionHostIds: readonly ExecutionHostId[]
  disabled: boolean
  onChange: (mutedExecutionHostIds: ExecutionHostId[]) => void
}

export function NotificationHostToggles({
  mutedExecutionHostIds,
  disabled,
  onChange
}: NotificationHostTogglesProps): React.JSX.Element | null {
  const { hostOptions } = useSidebarHostScopeOptions()
  // Why: with only this computer there is nothing to choose between.
  if (!shouldShowHostScopeControls(hostOptions)) {
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
          onToggle={() => onChange(toggleMutedExecutionHost(mutedExecutionHostIds, host.id))}
        />
      ))}
    </>
  )
}
