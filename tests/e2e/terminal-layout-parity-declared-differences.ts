import type {
  DeclaredParityDifference,
  UnstableOnMainPath
} from './terminal-layout-parity-snapshot'

/**
 * Differences from main this branch is allowed, each tied to the named bug it fixes. Keep empty
 * on an inert PR. Paths are prefixes of the runner's report paths, e.g. `[0].persisted.local`.
 */
export const TERMINAL_LAYOUT_PARITY_DECLARED_DIFFERENCES: readonly DeclaredParityDifference[] = []

/** Paths main itself does not reproduce; reported but not failed. Remove an entry once main is fixed. */
export const TERMINAL_LAYOUT_PARITY_UNSTABLE_ON_MAIN: readonly UnstableOnMainPath[] = [
  {
    scenario: 'close-pane',
    paths: ['[0].persisted.local.tabsByWorktree.#2::<repo>[0].ptyId'],
    // The saved tab.ptyId is the closed-around active pane's PTY or the last-spawned pane's PTY,
    // depending on whether a quit-time rewrite lands before exit.
    evidence:
      '1 of 14 paced runs on 17ecee6 saved the last-spawned pane (before exit status was captured)'
  }
]
