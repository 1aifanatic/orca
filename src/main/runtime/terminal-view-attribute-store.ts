/**
 * Phase 5 slice 2 (View-attribute bridge): main-side cache of the renderer's
 * `pty:terminalViewAttributes`
 * push. One app-global snapshot, not per-PTY — per-pane font zoom never
 * affects these attributes and the color/cursor settings are global.
 *
 * Null until the first push; the hidden-pane model responder answers its
 * OSC 4/12 and ?996n queries only once it is set. OSC 10/11 never reach it
 * from a current PTY owner, which answers them itself from the viewer colours
 * below. Staleness is bounded by one IPC hop; subscribed TUIs are corrected by
 * the renderer-owned 2031/997 flip.
 */
import {
  terminalViewAttributesEqual,
  terminalViewColorQueryReplyColors,
  type TerminalViewAttributes
} from '../../shared/terminal-view-attributes'
import type { TerminalOscColorQueryReplyColors } from '../../shared/terminal-osc-color-reply'
import { colorQueryReplyColorsEqual } from '../../shared/pty-owner-color-query-colors'

// Why module state (pattern of pty-hidden-delivery-gate.ts): pty.ts receives
// the push, the runtime emulators consult it at reply time via the getter.
let currentAttributes: TerminalViewAttributes | null = null

// Why one value for every pane: the host shows the same panes to every viewer, so OSC 10/11
// answer with the theme of whichever viewer acted last — this desktop or a paired client.
let viewerColors: TerminalOscColorQueryReplyColors | null = null
let viewerColorsListener: ((colors: TerminalOscColorQueryReplyColors) => void) | null = null

// Why appliers (pattern of registerConptyDa1OverrideInstaller): each push
// must also reach already-live emulators — cursor options under the replay
// guard, plus the per-PTY override reset a theme apply implies.
type TerminalViewAttributesApplier = (attributes: TerminalViewAttributes) => void
const pushAppliers = new Set<TerminalViewAttributesApplier>()

export function registerTerminalViewAttributesApplier(
  applier: TerminalViewAttributesApplier
): void {
  pushAppliers.add(applier)
}

/** Called from the pty:terminalViewAttributes IPC handler with a validated
 *  payload. Last push wins (replies always use the freshest snapshot). */
export function setTerminalViewAttributes(attributes: TerminalViewAttributes): void {
  // Why before the dedupe: an identical re-push still means this desktop is the viewer again.
  setTerminalViewerColors(terminalViewColorQueryReplyColors(attributes))
  // Why idempotent: the renderer publisher's dedupe is per-process, so a
  // fresh renderer (second window, reload, macOS re-activation) re-pushes
  // identical attributes. That is not a theme apply — fanning out would wipe
  // every PTY's OSC SET overlay while visible panes keep theirs.
  if (currentAttributes && terminalViewAttributesEqual(currentAttributes, attributes)) {
    return
  }
  currentAttributes = attributes
  for (const applier of pushAppliers) {
    applier(attributes)
  }
}

export function getTerminalViewAttributes(): TerminalViewAttributes | null {
  return currentAttributes
}

export function getTerminalViewColorQueryReplyColors(): TerminalOscColorQueryReplyColors | null {
  return currentAttributes ? terminalViewColorQueryReplyColors(currentAttributes) : null
}

export function setTerminalViewerColors(colors: TerminalOscColorQueryReplyColors): void {
  if (colorQueryReplyColorsEqual(viewerColors, colors)) {
    return
  }
  viewerColors = colors
  viewerColorsListener?.(colors)
}

export function getTerminalViewerColors(): TerminalOscColorQueryReplyColors | null {
  return viewerColors
}

/** One listener: the PTY IPC layer re-installs it on macOS re-activation. */
export function setTerminalViewerColorsListener(
  listener: ((colors: TerminalOscColorQueryReplyColors) => void) | null
): void {
  viewerColorsListener = listener
}

/** This desktop's window regained focus, so its own theme answers again. */
export function reassertDesktopTerminalViewerColors(): void {
  const colors = getTerminalViewColorQueryReplyColors()
  if (colors) {
    setTerminalViewerColors(colors)
  }
}

/** Test seam: reset module state between tests. */
export function _resetTerminalViewAttributesForTest(): void {
  currentAttributes = null
  pushAppliers.clear()
  viewerColors = null
  viewerColorsListener = null
}
