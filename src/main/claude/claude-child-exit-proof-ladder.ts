import type { SpawnedProcess } from '../../shared/child-process/run-process'
import { waitForProcessExitUntil } from '../codex/codex-process-exit-deadline'
import {
  PROVIDER_SUPERVISOR_MAX_STOP_MS,
  requestProviderClose,
  stopSupervisedProvider,
  type ProviderCloseRequest
} from '../codex/codex-app-server-posix-supervisor'
import type { ClaudeChildTreeReaper } from './claude-agent-sdk-exit-proof'

export const GRACEFUL_EXIT_MS = 1_500
const SUPERVISED_EXIT_SLACK_MS = 500
// A signalled supervisor escalates on its own; forcing it sooner kills it and orphans Claude.
export const SUPERVISED_GRACEFUL_EXIT_MS =
  PROVIDER_SUPERVISOR_MAX_STOP_MS + SUPERVISED_EXIT_SLACK_MS
const FORCED_EXIT_MS = 1_000
// Stdin end alone lets Claude finish its turn, tools and edits included; a close is a stop.
export const CLAUDE_CODE_CLOSE_REQUEST: ProviderCloseRequest = 'stdin-end-and-sigterm'

export type ClaudeChildExitProofInput = {
  child: Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin'>
  exitPromise: Promise<void>
  exited: () => boolean
  tree?: ClaudeChildTreeReaper
  /** The child is the POSIX provider supervisor: SIGTERM stops Claude, which reaps its tools. */
  supervised?: boolean
}

export async function proveClaudeChildExitWithReaper(
  input: ClaudeChildExitProofInput,
  createTree: () => ClaudeChildTreeReaper
): Promise<boolean> {
  const tree = input.tree ?? createTree()
  // Arm before the stop: only a live root can identify its descendants.
  await tree.capture()
  const reaped = await stopSupervisedProvider({
    request: () =>
      requestProviderClose({
        child: input.child,
        closeRequest: CLAUDE_CODE_CLOSE_REQUEST,
        supervised: input.supervised === true,
        exited: input.exited
      }),
    exitPromise: input.exitPromise,
    exited: input.exited,
    force: async () => {
      await tree.refresh?.()
      await tree.reap()
      await waitForProcessExitUntil(input.exitPromise, FORCED_EXIT_MS)
    },
    supervised: input.supervised === true,
    directWaitMs: GRACEFUL_EXIT_MS,
    slackMs: SUPERVISED_EXIT_SLACK_MS
  })
  if (!reaped && input.exited() && tree.treeVerdict !== 'exited') {
    await tree.reap()
  }
  return input.exited() && tree.treeVerdict === 'exited'
}
