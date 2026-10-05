import { translate } from '@/i18n/i18n'
import { isCommandToolName } from '../../../../shared/native-chat-tool-activity'
import { nativeChatToolCategory } from '../../../../shared/native-chat-tool-icon'
import {
  createToolInputDisplay,
  toolInputCommand
} from '../../../../shared/native-chat-tool-summary'
import type { NativeChatToolCallBlock } from '../../../../shared/native-chat-types'

export function nativeChatToolLineLabel(call: NativeChatToolCallBlock): {
  verb: string | null
  target: string
  title: string
  command: boolean
} {
  const display = createToolInputDisplay(call.input)
  const category = nativeChatToolCategory(call.name, call.mcpIdentity)
  const command = category !== 'mcpToolCall' && isCommandToolName(call.name)
  let verb: string | null = null
  let target = display.label
  const title = display.filePath ?? target

  if (command) {
    verb = translate('components.native-chat.tool.row.ran', 'Ran')
    target = toolInputCommand(call.input) ?? target
  } else if (category === 'read' || category === 'fileChange') {
    verb =
      category === 'read'
        ? translate('components.native-chat.tool.row.read', 'Read')
        : translate('components.native-chat.tool.row.edited', 'Edited')
    target = display.filePath?.split(/[\\/]/).findLast((part) => part.length > 0) ?? target
  } else if (category === 'search') {
    verb = translate('components.native-chat.tool.row.searched', 'Searched')
  } else if (category === 'webSearch') {
    if (call.name.trim().toLowerCase() === 'webfetch') {
      verb = translate('components.native-chat.tool.row.fetched', 'Fetched')
      try {
        const url = new URL(target)
        target = `${url.host}${url.pathname}${url.search}`
      } catch {
        // An incomplete URL still needs its original preview.
      }
    } else {
      verb = translate('components.native-chat.tool.row.searchedWeb', 'Searched the web')
    }
  }
  return { verb, target, title: command ? target : title, command }
}
