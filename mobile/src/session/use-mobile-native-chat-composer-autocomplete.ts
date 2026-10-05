import { useCallback, useEffect, useMemo } from 'react'
import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session-wire'
import {
  applyAutocomplete,
  detectAutocompleteTrigger,
  rankSuggestions
} from './mobile-native-chat-autocomplete'
import { mobileNativeChatSlashMenu } from './mobile-native-chat-slash-menu'
import {
  composerSuggestionInsertText,
  fileSuggestionSections,
  slashMenuSections,
  type ComposerSuggestion,
  type ComposerSuggestionSection
} from './MobileNativeChatComposerSuggestions'

const NO_SECTIONS: readonly ComposerSuggestionSection[] = []

/** The composer's `/` and `@` suggestions and how a pick edits the draft. */
export function useMobileNativeChatComposerAutocomplete(args: {
  value: string
  cursor: number
  agent: string | null | undefined
  structuredCommands: readonly AgentSessionConversationCommand[] | undefined
  sessionCommands: readonly AgentSessionSlashCommand[] | undefined
  filePaths: readonly string[]
  onNeedFiles: ((query: string) => void) | undefined
  onChangeText: (text: string) => void
  moveCaret: (cursor: number) => void
}): {
  sections: readonly ComposerSuggestionSection[]
  pick: (suggestion: ComposerSuggestion) => void
} {
  const { value, cursor, agent, structuredCommands, sessionCommands, filePaths } = args
  const { onNeedFiles, onChangeText, moveCaret } = args
  const trigger = useMemo(() => detectAutocompleteTrigger(value, cursor), [value, cursor])
  const triggerKind = trigger?.kind
  const query = trigger?.query ?? ''
  // Why: keyed on the trigger's primitives and stable catalog references only, so
  // streamed frames that re-render the composer never rebuild the rows.
  const sections = useMemo(() => {
    if (triggerKind === 'slash') {
      return slashMenuSections(
        mobileNativeChatSlashMenu({ agent, structuredCommands, sessionCommands, query })
      )
    }
    if (triggerKind === 'file') {
      return fileSuggestionSections(rankSuggestions(filePaths, query))
    }
    return NO_SECTIONS
  }, [agent, filePaths, query, sessionCommands, structuredCommands, triggerKind])

  useEffect(() => {
    if (triggerKind === 'file') {
      onNeedFiles?.(query)
    }
  }, [onNeedFiles, query, triggerKind])

  const pick = useCallback(
    (suggestion: ComposerSuggestion) => {
      if (!trigger) {
        return
      }
      const next = applyAutocomplete(value, trigger, composerSuggestionInsertText(suggestion))
      onChangeText(next.text)
      moveCaret(next.cursor)
    },
    [moveCaret, onChangeText, trigger, value]
  )
  return { sections, pick }
}
