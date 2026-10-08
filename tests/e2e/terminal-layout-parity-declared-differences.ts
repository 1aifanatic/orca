import type {
  DeclaredParityDifference,
  UnstableOnMainPath
} from './terminal-layout-parity-snapshot'

/**
 * Differences from main this branch is allowed, each tied to the named bug it fixes. Keep empty
 * on an inert PR. Paths are prefixes of the runner's report paths, e.g. `[0].persisted.local`.
 */
export const TERMINAL_LAYOUT_PARITY_DECLARED_DIFFERENCES: readonly DeclaredParityDifference[] = [
  // The core's mechanism: main alone authors terminal topology, so a window save no longer erases
  // main's per-pane incarnations, and the binding write counts every membership change it makes.
  // Saved-profile fields only; nothing on screen differs.
  ...[
    'create-tab',
    'split-right-down',
    'close-pane',
    'close-tab',
    'reorder-panes',
    'cli-split',
    'drag-out-to-tab',
    'restart-restore',
    'folder-workspace',
    'setup-split-first-activation',
    'sleep-quit-resume'
  ].map((scenario) => ({
    scenario,
    bugId: 'STA-9417',
    paths: ['[0]', '[1]', '[2]'].flatMap((checkpoint) => [
      `${checkpoint}.persisted.local.terminalTopologyRevisionByRepoId`,
      `${checkpoint}.persisted.local.terminalPtyIncarnationsByPaneKey`
    ]),
    reason: 'Main keeps the topology fields it authors; a window save no longer rewrites them.'
  })),
  {
    // The bug itself: main mints a second tab for the setup terminal (or leaves it with no pane);
    // the extra tab renumbers every later id, so the whole checkpoint differs.
    scenario: 'setup-split-first-activation',
    bugId: 'STA-9417',
    paths: ['[0].renderer', '[0].persisted.local'],
    reason:
      'Main mints a duplicate tab for the setup split on first activation; the core keeps one ' +
      "tab whose split holds both terminals, and keeps main's row (start folder) for that tab."
  }
]

/** Paths main itself does not reproduce; reported but not failed. Remove an entry once main is fixed. */
export const TERMINAL_LAYOUT_PARITY_UNSTABLE_ON_MAIN: readonly UnstableOnMainPath[] = [
  {
    // The window lists a tab's PTYs, and on main saves its row, in the order the woken panes'
    // respawns return; main usually but not always returns the first pane first.
    scenario: 'sleep-quit-resume',
    paths: [
      '[1].renderer.ptyIdsByTabId',
      '[1].renderer.tabsByWorktree.#4::<repo>[0].ptyId',
      '[1].persisted.local.tabsByWorktree.#4::<repo>[0].ptyId'
    ],
    evidence: 'main 61de2d8ec85 saved and listed the second pane first in 1 of 7 runs on macOS'
  }
]
