import { getPiStateTitleStatus } from '../../shared/pi-state-title-marker'
import type { RuledScreen } from './screen-ruled-agent-readiness'

const SETUP_STEP_HEADING_RE = /setup step \d+ of \d+/i

/**
 * OMP 18.4 runs its first-run setup wizard as a fullscreen overlay on the alternate screen, and
 * keys typed there drive the wizard (a provider picker), not the composer. Why the alternate
 * screen and not only the heading: the splash and outro scenes have no heading.
 */
export function isOmpSetupOverlayScreen(screen: RuledScreen): boolean {
  return screen.alternateScreen || screen.lines.some((line) => SETUP_STEP_HEADING_RE.test(line))
}

/** OMP's own idle state title (`π > cwd`), which it already paints before the setup wizard. */
export function isOmpIdleStateTitle(title: string | null | undefined): boolean {
  return title !== null && title !== undefined && getPiStateTitleStatus(title) === 'idle'
}
