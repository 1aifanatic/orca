import type { TuiAgent } from '../../shared/tui-agent'
import { isAntigravityComposerReadyScreen } from './antigravity-terminal-readiness'
import { isClineComposerReadyScreen } from './cline-terminal-readiness'

type ScreenReadyRule = (screenLines: readonly string[]) => boolean

/**
 * Agents whose live screen decides readiness. Each rule reads an idle composer off the grid,
 * which a folded text tail loses to cursor addressing. Why a clocked pane waits for quiet too:
 * the captures paint that composer for a moment mid-turn (a submit repaint, a spinner row
 * erased before its redraw).
 */
const SCREEN_READY_RULES: Partial<Record<TuiAgent, ScreenReadyRule>> = {
  antigravity: isAntigravityComposerReadyScreen,
  cline: isClineComposerReadyScreen
}

// Why no clockless tier 1: Cline repaints the same composer box while a reply streams.
const MID_TURN_COMPOSER_AGENTS: ReadonlySet<TuiAgent> = new Set(['cline'])

export function getScreenReadyRule(agent: TuiAgent | null): ScreenReadyRule | null {
  return agent === null ? null : (SCREEN_READY_RULES[agent] ?? null)
}

/**
 * Whether a trustworthy live screen decides this pane's readiness. When it does, the lanes that
 * cannot see a screen (a name-only title, a quiet process) must not settle what it refused.
 */
export function isReadinessDecidedByScreen(
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null
): boolean {
  return getScreenReadyRule(agent) !== null && readScreenLines() !== null
}

/**
 * Tier 1 for a screen-ruled pane with a live screen, or null to leave it to the text rules.
 * Why false for a clocked pane: its composer is also painted mid-turn, so the quiet lane decides.
 * Why a clockless pane keeps it: quiescence needs an output clock, which a restored pane lacks.
 */
export function readScreenRuledReady(
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null,
  hasOutputClock: boolean
): boolean | null {
  const rule = getScreenReadyRule(agent)
  const screenLines = rule ? readScreenLines() : null
  if (agent === null || rule === null || screenLines === null) {
    return null
  }
  if (hasOutputClock) {
    return false
  }
  return !MID_TURN_COMPOSER_AGENTS.has(agent) && rule(screenLines) ? true : null
}

/**
 * Tier 1b for a screen-ruled pane, or null for any other agent.
 * Why the text rules too: a grid out of step with the PTY garbles the chrome the rule reads, and
 * this lane took over their tier-1 verdict for a clocked pane.
 */
export function readScreenRuledQuietReady(
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null,
  readTextReady: () => boolean
): boolean | null {
  const rule = getScreenReadyRule(agent)
  if (rule === null) {
    return null
  }
  const screenLines = readScreenLines()
  return (screenLines !== null && rule(screenLines)) || readTextReady()
}
