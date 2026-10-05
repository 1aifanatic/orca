import type { AutomaticPromptId, PromptTurnState } from './automatic-prompt-turns'

export type UISlicePromptTurns = PromptTurnState & {
  /** Asks for a turn for one item. Idempotent per id and key; a new key replaces the id's last item,
   *  which then has to be shown again. */
  requestAutomaticPrompt: (id: AutomaticPromptId, key?: string | null) => void
  /** Withdraws an item, or ends its turn if it was showing. */
  releaseAutomaticPrompt: (id: AutomaticPromptId, key?: string | null) => void
  /** Called once the item is on screen: from here it keeps the turn until released. */
  markAutomaticPromptShown: (id: AutomaticPromptId, key?: string | null) => void
  setPromptBlockingDialogVisible: (id: string, visible: boolean) => void
  /** This machine's resume read has started; the launch wait now ends a fixed time after this. */
  beginLaunchPromptDiscovery: () => void
  /** This machine's resume offer has been read and decided, or none needs reading; launch prompts
   *  may now take turns. */
  settleLaunchPromptDiscovery: () => void
}
