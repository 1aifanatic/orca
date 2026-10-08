import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { subagentGroupBlocks } from '../../../../shared/native-chat-subagent-summary'
import type { NativeChatSubagentSections } from './native-chat-subagent-sections'

type NativeChatSlotIdentity =
  | { kind: 'message'; message: { id: string } }
  | { kind: 'subagent'; agentId: string }
  | { kind: 'subagent-entries'; rosterRowId: string; agents: readonly { id: string }[] }

/** Stable key for a slot: its message id, the agent whose section it heads, or its
 *  roster row and first entry. */
export function nativeChatSlotKey(slot: NativeChatSlotIdentity): string {
  switch (slot.kind) {
    case 'message':
      return slot.message.id
    case 'subagent':
      return `subagent-section:${slot.agentId}`
    case 'subagent-entries':
      return `subagent-entries:${slot.rosterRowId}:${slot.agents[0]?.id}`
  }
}

/** Loaded rows include folded messages and every possible section entry run. */
export function nativeChatLoadedRowKeys(
  messages: readonly NativeChatMessage[],
  sections: NativeChatSubagentSections
): ReadonlySet<string> {
  const keys = new Set(messages.map((message) => nativeChatSlotKey({ kind: 'message', message })))
  for (const key of sections.pathOf.keys()) {
    keys.add(key)
  }
  for (const agentId of sections.rows.keys()) {
    keys.add(nativeChatSlotKey({ kind: 'subagent', agentId }))
  }
  for (const message of messages) {
    for (const group of subagentGroupBlocks(message.blocks)) {
      for (const agent of group.agents) {
        keys.add(
          nativeChatSlotKey({ kind: 'subagent-entries', rosterRowId: message.id, agents: [agent] })
        )
      }
    }
  }
  return keys
}
