import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

/** Copies the host's address for this chat: `session:<root>`, or a structured worker's handle. */
export function NativeChatCopyAddressMenuItem({
  resolveAddress
}: {
  resolveAddress: () => Promise<string | null>
}): React.JSX.Element {
  const copyAddress = async (): Promise<void> => {
    try {
      const address = await resolveAddress()
      if (!address) {
        throw new Error('no orchestration address')
      }
      await window.api.ui.writeClipboardText(address)
      toast.success(
        translate(
          'components.native-chat.contextMenu.orchestrationAddressCopied',
          'Orchestration address copied'
        )
      )
    } catch {
      toast.error(
        translate(
          'components.native-chat.contextMenu.orchestrationAddressCopyFailed',
          'Unable to copy orchestration address'
        )
      )
    }
  }
  return (
    <DropdownMenuItem onSelect={() => void copyAddress()}>
      <Copy />
      {translate(
        'components.native-chat.contextMenu.copyOrchestrationAddress',
        'Copy Orchestration Address'
      )}
    </DropdownMenuItem>
  )
}
