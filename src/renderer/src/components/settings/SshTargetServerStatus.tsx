import { ArrowRightLeft } from 'lucide-react'
import { useState } from 'react'
import type { SshTarget } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { canMoveSshHostToManagedServer } from '@/ssh/ssh-managed-server-move'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { SshManagedServerMoveDialog } from './SshManagedServerMoveDialog'
import { sshHostServerStatusLine } from './ssh-host-server-status-copy'
import { SshHostChangedActions } from './SshHostChangedActions'

/** Which server this SSH host runs: its managed Orca server, or the relay and why. */
export function SshTargetServerStatus({
  target,
  onChanged
}: {
  target: SshTarget
  onChanged: () => void
}): React.JSX.Element | null {
  const state = useAppStore((s) => s.sshConnectionStates.get(target.id))
  const [moveOpen, setMoveOpen] = useState(false)
  const line = sshHostServerStatusLine(target, state)
  if (!line) {
    return null
  }
  const status = state?.managedServer
  const terminals = status?.kind === 'relay' ? (status.terminals ?? 0) : 0
  const canMove = line.action === 'move' && canMoveSshHostToManagedServer()
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p
          className={cn(
            'px-1 text-xs',
            line.tone === 'muted' && 'text-muted-foreground',
            line.tone === 'warning' && 'text-status-warning',
            line.tone === 'destructive' && 'text-destructive'
          )}
        >
          {line.text}
        </p>
        {canMove ? (
          <Button type="button" size="xs" variant="ghost" onClick={() => setMoveOpen(true)}>
            <ArrowRightLeft />
            {translate('auto.ssh.managedServerMove.title', 'Move to managed server')}
          </Button>
        ) : null}
      </div>
      <SshHostChangedActions target={target} onChanged={onChanged} />
      {canMove ? (
        <SshManagedServerMoveDialog
          open={moveOpen}
          targetId={target.id}
          host={target.label}
          terminals={terminals}
          onClose={() => setMoveOpen(false)}
        />
      ) : null}
    </div>
  )
}
