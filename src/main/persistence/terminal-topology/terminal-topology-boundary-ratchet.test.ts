/**
 * Ratchet: the primary enforcement of the terminal topology commit boundary. Only
 * `persistence/terminal-topology/**` and the callers listed here may call the binding writer or
 * a session sink. A new caller fails; so does a listed caller that stopped calling, so each
 * routing PR deletes its own rows. Checks that a call exists, not what it writes.
 */
import { existsSync, globSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../../../..')
const BOUNDARY_DIR = 'src/main/persistence/terminal-topology/'
const TEST_SOURCE =
  /(\.test\.tsx?|\.spec\.tsx?|fixtures?\.ts|test-harness[^/]*\.ts)$|\/__fixtures__\//

const LOADING_STORE = 'src/main/persistence/loading-store/'
const SESSION_SNAPSHOT_OPERATIONS = `${LOADING_STORE}session-snapshot-operations.ts`

/** Callers outside the boundary as of B1-1, by callee. */
const ALLOWED_CALLERS: Record<string, readonly string[]> = {
  // Binding moves behind the boundary in B1-4 (spawns) and B1-6/B1-8 (relay, stable owner).
  persistPtyBinding: [
    'src/main/ipc/pty/ipc/spawn-commit-persist.ts',
    'src/main/ipc/pty/pane/stable-owner.ts',
    'src/main/ipc/pty/runtime/spawn-commit.ts',
    'src/main/ssh/ssh-relay-session.ts'
  ],
  setWorkspaceSession: [
    'src/main/ipc/pty/pane/stable-owner.ts',
    'src/main/ipc/session.ts',
    SESSION_SNAPSHOT_OPERATIONS,
    'src/main/runtime/client-hosted-browser-page-persistence.ts',
    'src/main/runtime/orca-runtime-attach-window.ts',
    'src/main/runtime/orca-runtime-build-headless-mobile-session-browser-tabs.ts',
    'src/main/runtime/orca-runtime-persist-terminal-surface-retirements.ts',
    'src/main/runtime/orca-runtime-stop-terminals-for-worktree.ts',
    'src/main/runtime/runtime-legacy-worker-terminal-recovery-persistence.ts',
    'src/main/runtime/runtime-workspace-session-controller.ts'
  ],
  patchWorkspaceSession: ['src/main/ipc/session.ts'],
  stageWorkspaceSessionBeforeUnload: ['src/main/ipc/renderer-shutdown-checkpoint.ts'],
  setWorkspaceSessionForWorktree: [
    'src/main/runtime/orca-runtime-adopt-terminal-orphans-from-inventory.ts',
    'src/main/runtime/orca-runtime-apply-mobile-session-tab-navigation.ts',
    'src/main/runtime/orca-runtime-build-headless-mobile-session-browser-tabs.ts',
    'src/main/runtime/orca-runtime-move-headless-mobile-session-tab.ts',
    'src/main/runtime/orca-runtime-persist-headless-session-tab-props.ts',
    'src/main/runtime/orca-runtime-persist-headless-terminal-title.ts',
    'src/main/runtime/orca-runtime-pty-foreground-process-reads.ts'
  ],
  // The local and host sinks, and the helper all three sinks publish through.
  setLocalWorkspaceSession: [SESSION_SNAPSHOT_OPERATIONS],
  setHostWorkspaceSession: [SESSION_SNAPSHOT_OPERATIONS],
  publishWorkspaceSessionPartition: [
    `${LOADING_STORE}session-host-partitions.ts`,
    SESSION_SNAPSHOT_OPERATIONS,
    `${LOADING_STORE}workspace-session-snapshot-publication.ts`
  ]
}

function calleeName(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee)) {
    return callee.text
  }
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : null
}

function callerFilesByCallee(): Map<string, Set<string>> {
  const callees = Object.keys(ALLOWED_CALLERS)
  const callers = new Map(callees.map((callee) => [callee, new Set<string>()]))
  const files = globSync('src/**/*.{ts,tsx}', { cwd: repoRoot })
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => !TEST_SOURCE.test(file) && !file.startsWith(BOUNDARY_DIR))
  for (const file of files) {
    const text = readFileSync(join(repoRoot, file), 'utf8')
    // Why prefilter: parsing all ~14k source files would dominate the suite's budget.
    if (!callees.some((callee) => text.includes(callee))) {
      continue
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression)
        if (name) {
          callers.get(name)?.add(file)
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
      expect([...(callers.get(callee) ?? [])].sort()).toEqual([...allowed].sort())
    })
  }

  it('every listed caller names an existing file', () => {
    for (const file of new Set(Object.values(ALLOWED_CALLERS).flat())) {
      expect(existsSync(join(repoRoot, file)), file).toBe(true)
    }
  })
})
