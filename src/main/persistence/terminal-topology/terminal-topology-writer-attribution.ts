/** Names the code that made a session sink write, for the test-only topology write guard. */

export const TEST_SEED_WRITER = 'test-seed'
export const UNKNOWN_WRITER = 'unknown'

// Sink files: every frame in them is plumbing. The writer is the first frame outside them.
const SINK_FILES: ReadonlySet<string> = new Set([
  'src/main/persistence/terminal-topology/terminal-topology-write-guard.ts',
  'src/main/persistence/terminal-topology/terminal-topology-writer-attribution.ts',
  'src/main/persistence/loading-store/workspace-session-partition-commit.ts',
  'src/main/persistence/loading-store/session-snapshot-operations.ts',
  'src/main/persistence/loading-store/workspace-session-snapshot-publication.ts',
  'src/main/persistence/loading-store/session-host-partitions.ts'
])

// Funnels inside larger files: only these functions are plumbing, so other writers there still show.
const FUNNEL_FUNCTIONS: ReadonlyMap<string, string> = new Map([
  ['src/main/runtime/runtime-workspace-session-controller.ts', '.set'],
  ['src/main/runtime/orca-runtime-get-runtime-id.ts', '.setWorkspaceSessionForWorktree']
])

const TEST_FILE_PATTERN =
  /(\.test\.tsx?|\.spec\.tsx?|fixtures?\.ts|test-harness[^/]*\.ts)$|\/__fixtures__\//

/** Captures the current stack deep enough to get past the sinks and their funnels. */
export function captureSinkWriteStack(): string | undefined {
  const stackTraceLimit = Error.stackTraceLimit
  Error.stackTraceLimit = 30
  try {
    return new Error('topology sink write').stack
  } finally {
    Error.stackTraceLimit = stackTraceLimit
  }
}

/** The repo-relative file of the first frame outside the sinks; test code reads as seeding. */
export function attributeTopologyWriter(stack: string | undefined, repoRoot: string): string {
  for (const frame of (stack ?? '').split('\n').slice(1)) {
    const file = repoRelativeFrameFile(frame, repoRoot)
    if (!file || SINK_FILES.has(file)) {
      continue
    }
    const funnel = FUNNEL_FUNCTIONS.get(file)
    if (funnel && frameFunctionName(frame).endsWith(funnel)) {
      continue
    }
    return TEST_FILE_PATTERN.test(file) || file.startsWith('tests/') ? TEST_SEED_WRITER : file
  }
  return UNKNOWN_WRITER
}

function frameFunctionName(frame: string): string {
  return /^\s*at (?:async )?(\S+) \(/.exec(frame)?.[1] ?? ''
}

function repoRelativeFrameFile(frame: string, repoRoot: string): string | null {
  const match = /([^()\s]+\.[cm]?[jt]sx?):\d+:\d+\)?\s*$/.exec(frame)
  if (!match) {
    return null
  }
  // Why normalize first: a Windows dependency frame must still hit the node_modules skip.
  let path = match[1].replaceAll('\\', '/')
  if (path.startsWith('file://')) {
    path = path.slice('file://'.length).replace(/^\/([A-Za-z]:\/)/, '$1')
  }
  if (path.includes('/node_modules/')) {
    return null
  }
  const root = `${repoRoot.replaceAll('\\', '/').replace(/\/+$/, '')}/`
  // Windows drive paths compare case-insensitively.
  const foldCase = /^[A-Za-z]:\//.test(root)
  const inRepo = foldCase
    ? path.toLowerCase().startsWith(root.toLowerCase())
    : path.startsWith(root)
  return inRepo ? path.slice(root.length) : null
}
