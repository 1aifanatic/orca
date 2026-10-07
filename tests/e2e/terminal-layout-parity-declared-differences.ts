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
    scenario: 'setup-split-first-activation',
    bugId: 'STA-9417',
    paths: [
      '[0].renderer.tabsByWorktree.#2::<setup-worktree>[0].startupCwd',
      '[0].persisted.local.tabsByWorktree.#2::<setup-worktree>[0].startupCwd'
    ],
    reason:
      "A host-created tab keeps main's row (its start folder is the worktree root); the window " +
      'no longer replaces it with its own copy first.'
  }
]

/** Paths main itself does not reproduce; reported but not failed. Remove an entry once main is fixed. */
export const TERMINAL_LAYOUT_PARITY_UNSTABLE_ON_MAIN: readonly UnstableOnMainPath[] = []
