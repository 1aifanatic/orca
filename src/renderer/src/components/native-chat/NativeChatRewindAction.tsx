import { Undo2 } from 'lucide-react'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { NativeChatRewindSurface } from './use-native-chat-rewind'

export function NativeChatRewindAction({
  itemId,
  rewind
}: {
  itemId: string
  rewind: NativeChatRewindSurface
}) {
  const confirm = useConfirmationDialog()
  const label = translate('components.native-chat.rewind.action', 'Revert to here')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground aria-disabled:opacity-50"
          aria-label={label}
          aria-description={rewind.disabledReason ?? undefined}
          aria-disabled={Boolean(rewind.disabledReason)}
          onClick={() => {
            if (!rewind.disabledReason) {
              void rewind.request(itemId, confirm)
            }
          }}
        >
          <Undo2 className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {rewind.disabledReason ?? label}
      </TooltipContent>
    </Tooltip>
  )
}
