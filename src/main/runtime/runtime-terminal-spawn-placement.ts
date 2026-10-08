import type { TerminalPanePlacement } from '../../shared/terminal-pane-placement'
import type { TerminalPaneSplitDirection } from '../../shared/terminal-tab-types'
import type { RuntimeTerminalPresentation } from '../../shared/runtime-terminal-contracts'

/**
 * A main-side create always opens its own tab. Its title names the tab its reveal shows; a
 * background create reveals none, so it names none.
 */
export function runtimeNewTabPlacement(
  title: string | null | undefined,
  presentation: RuntimeTerminalPresentation | undefined
): TerminalPanePlacement {
  return title && presentation !== 'background'
    ? { kind: 'new-tab', row: { customTitle: title } }
    : { kind: 'new-tab' }
}

export function runtimeSplitPlacement(
  parentLeafId: string,
  direction: TerminalPaneSplitDirection
): TerminalPanePlacement {
  return { kind: 'split', parentLeafId, direction }
}
