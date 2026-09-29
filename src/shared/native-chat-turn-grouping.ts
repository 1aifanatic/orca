// Which turn each transcript row belongs to, and where each turn draws its bar. Shared because
// desktop and mobile both group rows and place bars from these keys, and a row grouped differently
// on each surface is the same bug twice.

import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { readAgentJournalTurn } from './agent-session-turn-record'
import type { NativeChatRole } from './native-chat-types'

type NativeChatTurnRow = { id: string; role: NativeChatRole }

/**
 * Resolve each row's turn key. The host's attribution (`turnKeysByItemId`) wins, so rows after a
 * mid-turn send stay with the turn that produced them. Rows it cannot name keep positional
 * grouping — an unmapped user row keys itself, anything else inherits the previous row's key —
 * which with no attribution is exactly preceding-user-message grouping.
 */
export function nativeChatRowTurnKeys(
  messages: readonly NativeChatTurnRow[],
  turnKeysByItemId?: ReadonlyMap<string, string> | null
): (string | undefined)[] {
  let currentTurnKey: string | undefined
  return messages.map((message) => {
    const owned = turnKeysByItemId?.get(message.id)
    if (owned !== undefined) {
      currentTurnKey = owned
      return owned
    }
    if (message.role === 'user') {
      currentTurnKey = message.id
    }
    return currentTurnKey
  })
}

/**
 * Turn ownership for a host that states no turn scope, read from journal order: every item between
 * a root turn record and the next belongs to that record's turn (the record is appended when the
 * turn opens, and an opener's user item is written ahead of dispatch). `recordKeys` maps each root
 * record to its anchor, or null when it names no opener. A user item that opened any turn keys
 * itself; one the provider folded into a running turn (a steer) takes that turn's key, but only
 * once the turn produces more rows after it, so a fresh tail send is not pulled into the turn it
 * is merely waiting behind. Items before the first record stay absent.
 */
export function nativeChatJournalOrderTurnKeys(
  items: readonly AgentJournalRenderItem[],
  recordKeys: ReadonlyMap<string, string | null>
): ReadonlyMap<string, string> {
  const openers = new Set([...recordKeys.values()].filter((key) => key !== null))
  const keys = new Map<string, string>()
  let currentKey: string | null = null
  // User items folded into the current turn, held until a later row proves the turn continued.
  let pendingUserItemIds: string[] = []
  for (const item of items) {
    if (recordKeys.has(item.itemId)) {
      currentKey = recordKeys.get(item.itemId) ?? null
      pendingUserItemIds = []
      continue
    }
    if (readAgentJournalTurn(item.body)) {
      continue
    }
    if (item.body.kind === 'message' && item.body.role === 'user') {
      if (openers.has(item.itemId)) {
        keys.set(item.itemId, item.itemId)
      } else if (currentKey !== null) {
        pendingUserItemIds.push(item.itemId)
      }
      continue
    }
    if (currentKey !== null) {
      for (const userItemId of pendingUserItemIds) {
        keys.set(userItemId, currentKey)
      }
      pendingUserItemIds = []
      keys.set(item.itemId, currentKey)
    }
  }
  return keys
}

/** Where each turn draws its bar: its first row, and above that row when the turn has no user
 *  bubble of its own (one the provider opened, or whose opener is outside the loaded window). */
export function nativeChatTurnBarRows(
  messages: readonly { id: string }[],
  turnKeys: readonly (string | undefined)[]
): ReadonlyMap<string, { index: number; above: boolean }> {
  const bars = new Map<string, { index: number; above: boolean }>()
  turnKeys.forEach((turnKey, index) => {
    if (turnKey !== undefined && !bars.has(turnKey)) {
      bars.set(turnKey, { index, above: messages[index]?.id !== turnKey })
    }
  })
  return bars
}
