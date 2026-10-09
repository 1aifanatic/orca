/**
 * What becomes of a launch's initial text, and what the receipt is allowed to say about it.
 *
 * Split from the executor because they answer different questions. The executor decides WHICH
 * surface exists and in what order; everything here decides how the text reaches whichever surface
 * that turned out to be, and each surface takes it differently:
 *
 *   structured session   ->  committed to the transcript, named by a message id  ->  journaled
 *   terminal, line fits  ->  folded into the command that execs the agent        ->  handed-to-terminal
 *   terminal, otherwise  ->  bracketed paste into the live PTY once it is ready  ->  handed-to-terminal
 *   anything unproven    ->                                                      ->  not-delivered
 *   interrupted delivery or a replay with uncertain delivery                 ->  unconfirmed
 *
 * argv has no readiness race, so it is offered wherever the agent's CLI takes a prompt argument
 * (`agentPromptRidesLaunchCommand`). But that command is TYPED into the user's shell, and a long or
 * multi-line typed line fails in ways argv itself does not, so whether the offer was taken is decided
 * where the line is built (`startup-line-prompt-carry`) and reported back, never predicted here.
 */

import type {
  AgentLaunchIntent,
  AgentLaunchPromptDisposal,
  AgentLaunchResult
} from '../../shared/agent-launch-intent'
import { agentPromptRidesLaunchCommand } from '../../shared/tui-agent-startup'
import type { AgentLaunchModeReceipt } from './agent-launch-mode'
import type { AgentLaunchExecution, CreatedSurface } from './agent-launch-executor'
import type { AgentLaunchStructuredSurface } from './agent-launch-surface-factories'
import { isDesktopNewTabPrompt } from '../../shared/desktop-new-tab-prompt'

export const HANDED_TO_TERMINAL: AgentLaunchPromptDisposal = { outcome: 'handed-to-terminal' }
const NOT_DELIVERED: AgentLaunchPromptDisposal = { outcome: 'not-delivered' }
const UNCONFIRMED: AgentLaunchPromptDisposal = { outcome: 'unconfirmed' }

/**
 * What the record may say before any delivery runs: only what creating the surface already settled.
 * Startup-carried text is handed over. Pending submissions and desktop pastes stay `unconfirmed`
 * until delivery settles, so an interrupted launch cannot invite a duplicate paste.
 */
export function settledAtCreation(
  intent: Pick<AgentLaunchIntent, 'prompt'>,
  created: { promptRodeLaunchCommand?: boolean }
): AgentLaunchPromptDisposal {
  if (created.promptRodeLaunchCommand) {
    return HANDED_TO_TERMINAL
  }
  if (isDesktopNewTabPrompt(intent.prompt)) {
    return intent.prompt.text.trim() ? UNCONFIRMED : NOT_DELIVERED
  }
  return intent.prompt?.delivery === 'submit' ? UNCONFIRMED : NOT_DELIVERED
}

/** Each surface delivers its own way, so the disposal is decided where the surface is known. */
export async function settleLaunchPromptDisposal(
  execution: AgentLaunchExecution,
  created: CreatedSurface
): Promise<AgentLaunchPromptDisposal> {
  if (created.structured) {
    const messageId = await deliverStructuredLaunchPrompt(execution, created.structured)
    return messageId ? { outcome: 'journaled', messageId } : NOT_DELIVERED
  }
  // The surface reported that the startup command carried the prompt; there is nothing left to write.
  if (created.promptRodeLaunchCommand) {
    return HANDED_TO_TERMINAL
  }
  return deliverTerminalLaunchPrompt(execution, created.outcome.handle, { freshLaunch: true })
}

/**
 * Commits the launch text to a structured session's transcript.
 *
 * `draft` is excluded: a structured draft belongs in the composer, and the host has none.
 */
async function deliverStructuredLaunchPrompt(
  execution: AgentLaunchExecution,
  structured: AgentLaunchStructuredSurface
): Promise<string | null> {
  const { intent, surfaces } = execution
  if (!intent.prompt || intent.prompt.delivery !== 'submit') {
    return null
  }
  return (
    (await surfaces.deliverStructuredPrompt?.({
      sessionId: structured.sessionId,
      fence: structured.fence,
      prompt: intent.prompt
    })) ?? null
  )
}

/**
 * Writes the launch text into a terminal agent that is already running.
 *
 * The host owns the PTY, so it is better placed to write into one than the renderer that used to:
 * a pane owner can only deliver while its own window is open, which is why mobile and the CLI
 * never got a terminal prompt at all. What the host cannot see is what the agent then does with
 * it — a terminal keeps no transcript — so this reports `handed-to-terminal`, never `journaled`.
 *
 * Desktop drafts report the unsubmitted paste as handed over; generic drafts remain caller-owned.
 */
export async function deliverTerminalLaunchPrompt(
  execution: AgentLaunchExecution,
  handle: string,
  { freshLaunch }: { freshLaunch: boolean }
): Promise<AgentLaunchPromptDisposal> {
  const { intent, surfaces } = execution
  if (
    !intent.prompt ||
    (intent.prompt.delivery !== 'submit' && !isDesktopNewTabPrompt(intent.prompt))
  ) {
    return NOT_DELIVERED
  }
  if (isDesktopNewTabPrompt(intent.prompt) && !intent.prompt.text.trim()) {
    return NOT_DELIVERED
  }
  let writeUnconfirmed = false
  let composerUnobserved = false
  const delivered = await surfaces.deliverTerminalPrompt?.({
    handle,
    agent: intent.agent,
    freshLaunch,
    prompt: intent.prompt,
    onComposerUnobserved: () => {
      composerUnobserved = true
    },
    ...(isDesktopNewTabPrompt(intent.prompt)
      ? {
          onWriteUnconfirmed: () => {
            writeUnconfirmed = true
          }
        }
      : {})
  })
  if (!delivered) {
    return writeUnconfirmed ? UNCONFIRMED : NOT_DELIVERED
  }
  return composerUnobserved
    ? { outcome: 'handed-to-terminal', composerUnobserved: true }
    : HANDED_TO_TERMINAL
}

/** The launch text that has to reach a surface, or undefined when there is none to deliver. */
function launchSubmitText(intent: AgentLaunchIntent): string | undefined {
  return intent.prompt?.delivery === 'submit' && intent.prompt.text ? intent.prompt.text : undefined
}

/**
 * The prompt offered to a terminal's launch command, which is an argv-mode agent's and only an
 * argv-mode agent's. An offer, not a decision: the surface reports whether the typed line took it.
 */
export function argvLaunchPrompt(intent: AgentLaunchIntent): string | undefined {
  const text = launchSubmitText(intent)
  return text &&
    !isDesktopNewTabPrompt(intent.prompt) &&
    intent.prompt?.transport !== 'paste' &&
    agentPromptRidesLaunchCommand(intent.agent)
    ? text
    : undefined
}

/** The same question before a surface exists, where a structured create must carry no prompt: its
 *  text is journaled into the session afterwards, not folded into a command. */
export function launchCommandPrompt(
  intent: AgentLaunchIntent,
  mode: AgentLaunchModeReceipt['mode']
): string | undefined {
  return mode === 'terminal' ? argvLaunchPrompt(intent) : undefined
}

/**
 * The one place a receipt is built, so a disposal cannot be reported without the delivery it
 * belongs to.
 *
 * Each arm is a consequence of the act it names, never a write-ahead of it: `journaled` is
 * reachable only from a committed message id, `handed-to-terminal` only from a launch command that
 * carried the text or a PTY write that returned. An interrupted desktop write and a provisional
 * recorded result stay `unconfirmed`; a refusal before any write is `not-delivered`.
 */
export function promptReceipt(
  intent: AgentLaunchIntent,
  disposal: AgentLaunchPromptDisposal
): Pick<AgentLaunchResult, 'prompt'> {
  if (!intent.prompt || (isDesktopNewTabPrompt(intent.prompt) && !intent.prompt.text.trim())) {
    return {}
  }
  return { prompt: { delivery: intent.prompt.delivery, ...disposal } }
}
