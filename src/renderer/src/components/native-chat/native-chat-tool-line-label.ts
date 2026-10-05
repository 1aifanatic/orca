import { translate } from '@/i18n/i18n'
import { nativeChatToolCategory } from '../../../../shared/native-chat-tool-icon'
import {
  createToolInputDisplay,
  toolInputCommand
} from '../../../../shared/native-chat-tool-summary'
import type {
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../../../shared/native-chat-types'

function fetchUrl(input: unknown): string | null {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  return value !== null &&
    typeof value === 'object' &&
    'url' in value &&
    typeof value.url === 'string'
    ? value.url
    : null
}

export function nativeChatToolLineLabel(
  call: NativeChatToolCallBlock,
  result?: NativeChatToolResultBlock
): {
  verb: string | null
  target: string
  title: string
  command: boolean
  filePath: string | null
} {
  const display = createToolInputDisplay(call.input)
  const category = nativeChatToolCategory(call.name, call.mcpIdentity)
  const command = category === 'unknown'
  const running = call.state === 'running'
  const completed =
    call.state !== 'failed' &&
    !result?.isError &&
    (call.state === 'completed' || result !== undefined)
  let verb: string | null = null
  let target = display.label
  let title = display.filePath ?? target
  const filePath = category === 'read' || category === 'fileChange' ? display.filePath : null

  if (command) {
    target = toolInputCommand(call.input) ?? target
    title = target
    if (running) {
      verb = translate('components.native-chat.tool.row.running', 'Running')
    } else if (completed) {
      verb = translate('components.native-chat.tool.row.ran', 'Ran')
    }
  } else if (category === 'read' || category === 'fileChange') {
    if (running) {
      verb =
        category === 'read'
          ? translate('components.native-chat.tool.row.reading', 'Reading')
          : translate('components.native-chat.tool.row.editing', 'Editing')
    } else if (completed) {
      verb =
        category === 'read'
          ? translate('components.native-chat.tool.row.read', 'Read')
          : translate('components.native-chat.tool.row.edited', 'Edited')
    }
    target = filePath?.split(/[\\/]/).findLast((part) => part.length > 0) ?? target
  } else if (category === 'search') {
    if (running) {
      verb = translate('components.native-chat.tool.row.searching', 'Searching')
    } else if (completed) {
      verb = translate('components.native-chat.tool.row.searched', 'Searched')
    }
  } else if (category === 'listFiles') {
    if (running) {
      verb = translate('components.native-chat.tool.row.listing', 'Listing')
    } else if (completed) {
      verb = translate('components.native-chat.tool.row.listed', 'Listed')
    }
  } else if (category === 'webSearch') {
    if (call.name.trim().toLowerCase() === 'webfetch') {
      const url = fetchUrl(call.input) ?? target
      target = url.replace(/^[a-z][a-z\d+.-]*:\/\//i, '')
      title = url
      if (running) {
        verb = translate('components.native-chat.tool.row.fetching', 'Fetching')
      } else if (completed) {
        verb = translate('components.native-chat.tool.row.fetched', 'Fetched')
      }
    } else if (running) {
      verb = translate('components.native-chat.tool.row.searchingWeb', 'Searching the web')
    } else if (completed) {
      verb = translate('components.native-chat.tool.row.searchedWeb', 'Searched the web')
    }
  }
  return { verb, target, title, command, filePath }
}
