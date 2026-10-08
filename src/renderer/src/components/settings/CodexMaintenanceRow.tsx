import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCodexMaintenance } from '@/hooks/useCodexMaintenance'
import type { CodexMaintenanceTarget } from '@/lib/codex-maintenance-client'
import {
  codexMaintenanceSettingsStatus,
  codexMaintenanceCommandText
} from '../native-chat/codex-maintenance-copy'

export function CodexMaintenanceRow({
  target
}: {
  target: CodexMaintenanceTarget
}): React.JSX.Element | null {
  const maintenance = useCodexMaintenance(target)
  const installation = maintenance.installation
  const status = installation ? codexMaintenanceSettingsStatus(installation) : null
  if (!status) {
    return null
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{status}</span>
      {maintenance.action ? (
        <Button
          variant="outline"
          size="xs"
          disabled={maintenance.action.disabled}
          onClick={maintenance.action.onClick}
        >
          {maintenance.busy ? <Loader2 className="size-3 animate-spin" /> : null}
          {maintenance.action.label}
        </Button>
      ) : maintenance.state?.action ? (
        <code className="select-text font-mono text-xs">
          {codexMaintenanceCommandText(
            maintenance.state.action,
            installation?.minimumVersion ?? ''
          )}
        </code>
      ) : null}
    </div>
  )
}
