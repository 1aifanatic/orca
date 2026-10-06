import { createElement } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { NativeChatTurnJournal } from '../../../src/shared/native-chat-turn-membership'
import type { NativeChatSettledTurns } from '../../../src/shared/native-chat-turn-status'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

export function MobileNativeChatTurnDisclosureHarness({
  messages,
  enabled,
  isWorking = true,
  settledTurns,
  turnJournal,
  workingStartedAt,
  thinking,
  lineYields,
  scopeKey = 'host\0worktree\0tab-a'
}: {
  messages: readonly NativeChatMessage[]
  enabled: boolean
  isWorking?: boolean
  settledTurns?: NativeChatSettledTurns
  turnJournal?: NativeChatTurnJournal
  workingStartedAt?: number | null
  thinking?: boolean
  lineYields?: boolean
  scopeKey?: string
}): React.JSX.Element {
  const disclosure = useMobileNativeChatTurnDisclosure({
    messages,
    enabled,
    isWorking,
    settledTurns,
    turnJournal,
    workingStartedAt,
    thinking,
    lineYields,
    scopeKey
  })
  return createElement('result', { disclosure })
}
