/**
 * Ratchet: the enforcement of the terminal topology commit boundary. Only
 * `persistence/terminal-topology/**` and the callers listed here may call the binding writer or a
 * session setter. A new caller fails; so does a listed caller that stopped calling, so each
 * routing PR deletes its own rows. Checks that a call exists, not what it writes: direct state
 * assignments and in-place mutation are invisible to it. Paths are relative to `src/main`.
 */
import { resolve } from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'
import { scanSourceTree } from '../../../shared/source-scan/source-tree-scan'

const MAIN_ROOT = resolve(__dirname, '../..')
const BOUNDARY_DIR = 'persistence/terminal-topology/'
// Why: the shared walk exempts `*-test-fixture.ts` but not this name, which the audit reproducer
// in docs/audits/acknowledged-tab-retirement pins.
const TEST_SUPPORT = 'runtime/acknowledged-terminal-tab-retirement-fixture.ts'

/** Callers outside the boundary, by callee; each routing change deletes its own rows. */
const ALLOWED_CALLERS: Record<string, readonly string[]> = {
  persistPtyBinding: [
    'ipc/pty/ipc/spawn-commit-persist.ts',
    'ipc/pty/pane/stable-owner.ts',
    'ipc/pty/runtime/spawn-commit.ts',
    'ssh/ssh-relay-session.ts'
  ],
  setWorkspaceSession: [
    'ipc/pty/pane/stable-owner.ts',
    'ipc/session.ts',
    // Store-internal: patchWorkspaceSession -> setWorkspaceSession.
    'persistence/loading-store/session-snapshot-operations.ts',
    'runtime/client-hosted-browser-page-persistence.ts',
    'runtime/orca-runtime-attach-window.ts',
    'runtime/orca-runtime-build-headless-mobile-session-browser-tabs.ts',
    'runtime/orca-runtime-persist-terminal-surface-retirements.ts',
    'runtime/orca-runtime-stop-terminals-for-worktree.ts',
    'runtime/runtime-legacy-worker-terminal-recovery-persistence.ts',
    'runtime/runtime-workspace-session-controller.ts'
  ],
  // The runtime's session controller, reachable from every OrcaRuntime mixin.
  setForWorktree: ['runtime/orca-runtime-get-runtime-id.ts'],
  patchWorkspaceSession: ['ipc/session.ts'],
  stageWorkspaceSessionBeforeUnload: ['ipc/renderer-shutdown-checkpoint.ts'],
  setWorkspaceSessionForWorktree: [
    'runtime/orca-runtime-adopt-terminal-orphans-from-inventory.ts',
    'runtime/orca-runtime-apply-mobile-session-tab-navigation.ts',
    'runtime/orca-runtime-build-headless-mobile-session-browser-tabs.ts',
    'runtime/orca-runtime-move-headless-mobile-session-tab.ts',
    'runtime/orca-runtime-persist-headless-session-tab-props.ts',
    'runtime/orca-runtime-persist-headless-terminal-title.ts',
    'runtime/orca-runtime-pty-foreground-process-reads.ts'
  ]
}

function callerFilesByCallee(): Map<string, Set<string>> {
  const callees = Object.keys(ALLOWED_CALLERS)
  const callers = new Map(callees.map((callee) => [callee, new Set<string>()]))
  for (const file of scanSourceTree(MAIN_ROOT)) {
    // Why prefilter: parsing every main-process file would dominate the test's budget.
    if (
      file.relativePath.startsWith(BOUNDARY_DIR) ||
      file.relativePath === TEST_SUPPORT ||
      !callees.some((callee) => file.source.includes(callee))
    ) {
      continue
    }
    const source = ts.createSourceFile(file.relativePath, file.source, ts.ScriptTarget.Latest)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        if (ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)) {
          const name = ts.isIdentifier(callee) ? callee.text : callee.name.text
          callers.get(name)?.add(file.relativePath)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return callers
}

describe('terminal topology boundary ratchet', () => {
  const callers = callerFilesByCallee()

  for (const [callee, allowed] of Object.entries(ALLOWED_CALLERS)) {
    it(`only the boundary and listed callers call ${callee}`, () => {
      expect(callers.get(callee)).toEqual(new Set(allowed))
    })
  }
})
