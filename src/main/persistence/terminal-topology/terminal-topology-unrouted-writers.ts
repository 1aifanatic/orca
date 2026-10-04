/**
 * Writers that still change class-(a) topology through a session sink outside the commit module,
 * keyed by repo-relative file. Each routing PR deletes its own entries; the test-only write guard
 * fails any test where a writer not listed here does it. Ids are the plan's census rows.
 */
export const UNROUTED_TOPOLOGY_WRITERS: Readonly<Record<string, string>> = {
  'src/main/runtime/orca-runtime-stop-terminals-for-worktree.ts':
    'R5 → clearWorktreeResumeRecords (B1-8)',
  'src/main/runtime/orca-runtime-persist-terminal-surface-retirements.ts':
    'R6 → retireSurfaces (B1-8)',
  'src/main/runtime/orca-runtime-adopt-terminal-orphans-from-inventory.ts':
    'R9 → adoptOrphan (B1-8)',
  'src/main/runtime/orca-runtime-apply-mobile-session-tab-navigation.ts':
    'R10 deleted by split placement (B1-4); R11 → writePresentation (B1-9)',
  'src/main/runtime/orca-runtime-attach-window.ts': 'R13 → recordWindowlessBindings (B1-9)',
  'src/main/runtime/orca-runtime-persist-headless-session-tab-props.ts':
    'R15 → writePresentation, R16 → setLayout (B1-9)',
  'src/main/runtime/runtime-legacy-worker-terminal-recovery-persistence.ts':
    'R17 → retireSurfaces + wakeLeaf (B1-8)',
  'src/main/ipc/pty/pane/stable-owner.ts': 'R19 → retireSurfaces (B1-8)'
}
