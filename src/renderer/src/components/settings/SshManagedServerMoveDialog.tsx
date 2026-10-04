import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import {
  describeManagedServerMove,
  managedServerMoveErrorText,
  managedServerMoveOfferText
} from '@/ssh/ssh-managed-server-move'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

type SshManagedServerMoveDialogProps = {
  open: boolean
  targetId: string
  host: string
  terminals: number | undefined
  onClose: () => void
}

/** Confirms moving a host whose live relay terminals keep it off its managed server. */
export function SshManagedServerMoveDialog({
  open,
  targetId,
  host,
  terminals,
  onClose
}: SshManagedServerMoveDialogProps): React.JSX.Element {
  const mountedRef = useMountedRef()
  const [running, setRunning] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  const close = (): void => {
    setRefusal(null)
    onClose()
  }

  const move = async (): Promise<void> => {
    const moveToManagedServer = window.api.ssh.moveToManagedServer
    if (!moveToManagedServer) {
      return
    }
    setRunning(true)
    setRefusal(null)
    let message: string | null
    try {
      const report = describeManagedServerMove(host, await moveToManagedServer({ targetId }))
      message = report.level === 'success' ? null : report.message
    } catch (error) {
      message = managedServerMoveErrorText(host, error)
    }
    if (!mountedRef.current) {
      return
    }
    setRunning(false)
    if (message) {
      setRefusal(message)
    } else {
      close()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !running && close()}>
      <DialogContent showCloseButton={!running}>
        <DialogHeader>
          <DialogTitle>
            {translate('auto.ssh.managedServerMove.title', 'Move to managed server')}
          </DialogTitle>
          <DialogDescription>{managedServerMoveOfferText(host, terminals)}</DialogDescription>
        </DialogHeader>
        {running ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {translate(
              'auto.ssh.managedServerMove.running',
              'Moving {{host}} to a managed Orca server…',
              { host }
            )}
          </div>
        ) : null}
        {refusal ? <p className="text-sm text-destructive">{refusal}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={running} onClick={close}>
            {refusal
              ? translate('auto.ssh.managedServerMove.close', 'Close')
              : translate('auto.ssh.managedServerMove.notNow', 'Not now')}
          </Button>
          {refusal ? null : (
            <Button type="button" disabled={running} onClick={() => void move()}>
              {translate('auto.ssh.managedServerMove.confirm', 'Move')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
