import type { AutomaticPromptId, PromptTurnState } from './automatic-prompt-turns'

export type UISlicePromptTurns = PromptTurnState & {
  /** Asks for a turn. Idempotent per id; the request keeps its place until released. */
  requestAutomaticPrompt: (id: AutomaticPromptId) => void
  /** Withdraws a request, or ends the turn of the prompt that was showing. */
  releaseAutomaticPrompt: (id: AutomaticPromptId) => void
  /** Called once the prompt is on screen: from here it keeps the turn until released. */
  markAutomaticPromptShown: (id: AutomaticPromptId) => void
  setPromptBlockingDialogVisible: (id: string, visible: boolean) => void
  /** This machine's resume offer has been read and decided; launch prompts may now take turns. */
  settleLaunchPromptDiscovery: () => void
}
