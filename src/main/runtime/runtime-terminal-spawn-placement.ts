import type { TerminalPanePlacement } from '../../shared/terminal-pane-placement'
import type { TerminalPaneSplitDirection } from '../../shared/terminal-tab-types'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'

/** The grid a main-side create spawns at; no view has measured one yet. */
export const RUNTIME_TERMINAL_SPAWN_GRID = { cols: 120, rows: 40 } as const

/** A main-side create opens its own tab; the row carries what the caller asked that tab to be. */
export function runtimeNewTabPlacement(
  opts: Pick<TerminalCreateOptions, 'title' | 'launchAgent' | 'viewMode' | 'shellOverride'>,
  startupCwd: string | undefined
): TerminalPanePlacement {
  return {
    kind: 'new-tab',
    row: {
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
      ...(opts.shellOverride ? { shellOverride: opts.shellOverride } : {}),
      ...(startupCwd ? { startupCwd } : {}),
      createdAt: Date.now()
    },
    size: { ...RUNTIME_TERMINAL_SPAWN_GRID }
  }
}

export function runtimeSplitPlacement(
  parentLeafId: string,
  direction: TerminalPaneSplitDirection
): TerminalPanePlacement {
  return { kind: 'split', parentLeafId, direction, ratio: 0.5 }
}
