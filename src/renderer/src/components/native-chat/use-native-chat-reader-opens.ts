import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react'
import {
  useNativeChatDisclosures,
  type NativeChatDisclosureStore
} from './native-chat-disclosure-store'
import { toggleNativeChatExpandedKey } from './native-chat-expanded-keys'
import type { NativeChatSubagentDisclosure } from './native-chat-subagent-sections'
import type { NativeChatTranscriptScroll } from './use-native-chat-transcript-scroll'

export function useNativeChatReaderOpens({
  subagentDisclosure,
  setExpandedTurnIds,
  follow,
  abortNavigation
}: {
  subagentDisclosure: NativeChatSubagentDisclosure
  setExpandedTurnIds: Dispatch<SetStateAction<ReadonlySet<string>>>
  follow: Pick<NativeChatTranscriptScroll, 'holdDisclosurePosition'>
  abortNavigation: () => void
}): {
  disclosures: NativeChatDisclosureStore
  subagentDisclosure: NativeChatSubagentDisclosure
  toggleExpandedTurn: (turnKey: string) => void
} {
  const disclosures = useNativeChatDisclosures()
  const { holdDisclosurePosition } = follow
  const readerToggled = useCallback(() => {
    abortNavigation()
    holdDisclosurePosition()
  }, [abortNavigation, holdDisclosurePosition])
  const readerDisclosures = useMemo(
    () => ({ ...disclosures, onToggle: readerToggled }),
    [disclosures, readerToggled]
  )
  const readerSubagentDisclosure = useMemo<NativeChatSubagentDisclosure>(
    () => ({
      setSectionOpen: (agentId, open) => {
        readerToggled()
        subagentDisclosure.setSectionOpen(agentId, open)
      },
      setRosterOpen: (rosterRowId, open) => {
        readerToggled()
        subagentDisclosure.setRosterOpen(rosterRowId, open)
      }
    }),
    [readerToggled, subagentDisclosure]
  )
  const toggleExpandedTurn = useCallback(
    (turnKey: string) => {
      readerToggled()
      setExpandedTurnIds((current) => toggleNativeChatExpandedKey(current, turnKey))
    },
    [readerToggled, setExpandedTurnIds]
  )
  return {
    disclosures: readerDisclosures,
    subagentDisclosure: readerSubagentDisclosure,
    toggleExpandedTurn
  }
}
