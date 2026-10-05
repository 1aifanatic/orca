import type { DeclaredParityDifference } from './terminal-layout-parity-snapshot'

/**
 * Differences from main this branch is allowed, each tied to the named bug it fixes. Keep empty
 * on an inert PR. Paths are prefixes of the runner's report paths, e.g. `[0].persisted.local`.
 */
export const TERMINAL_LAYOUT_PARITY_DECLARED_DIFFERENCES: readonly DeclaredParityDifference[] = []
