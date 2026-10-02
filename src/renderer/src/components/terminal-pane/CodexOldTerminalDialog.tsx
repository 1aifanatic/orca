import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'

/** Learn more for a terminal opened before Orca gave each Codex its own server. */
export function CodexOldTerminalDialog({
  open,
  onOpenChange,
  onOpenNewTerminal,
  onTurnOffSharing
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenNewTerminal: () => void
  onTurnOffSharing: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'terminal.codexSharedServerBanner.oldTerminalDialogTitle',
              'Why this Codex shares a server'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'terminal.codexSharedServerBanner.oldTerminalDialogRisk',
              'Codex sessions that share a server can end together, and agent status can be wrong.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>
            {translate(
              'terminal.codexSharedServerBanner.oldTerminalDialogCause',
              'This terminal started before Orca gave each Codex its own server. New terminals get one automatically.'
            )}
          </p>
          <p>
            {translate(
              'terminal.codexSharedServerBanner.oldTerminalDialogAction',
              'Open new terminal opens a fresh terminal beside this one. Codex in this terminal keeps running until you close it.'
            )}
          </p>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="ghost" onClick={onTurnOffSharing}>
            {translate(
              'terminal.codexSharedServerBanner.turnOffSharingEverywhere',
              'Turn off sharing everywhere'
            )}
          </Button>
          {/* Why autoFocus: the dialog opens on its primary action, not the first footer button. */}
          <Button type="button" autoFocus onClick={onOpenNewTerminal}>
            {translate('terminal.codexSharedServerBanner.openNewTerminal', 'Open new terminal')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
