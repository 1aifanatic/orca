import type { SpawnedProcess } from '../../shared/child-process/run-process'
import {
  closeProviderProcess,
  type ProviderProcessClosePolicy
} from '../provider-process/provider-process-close'
import type { ManagedProviderProcess } from '../provider-process/managed-provider-process'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
import type { ClaudeChildTreeReaper } from './claude-agent-sdk-exit-proof'

export const GRACEFUL_EXIT_MS = 1_500
// A signalled supervisor escalates on its own; forcing it sooner kills it and orphans Claude.
export const SUPERVISED_GRACEFUL_EXIT_MS = PROVIDER_SUPERVISOR_MAX_STOP_MS + 500
const FORCED_EXIT_MS = 1_000

export function claudeChildClosePolicy(supervised: boolean): ProviderProcessClosePolicy {
  return {
    gracefulExitMs: supervised ? SUPERVISED_GRACEFUL_EXIT_MS : GRACEFUL_EXIT_MS,
    forcedExitMs: FORCED_EXIT_MS,
    signalSupervisorOnClose: true,
    requireTreeExit: true
  }
}

export type ClaudeChildExitProofInput = {
  child: Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin'>
  exitPromise: Promise<void>
  exited: () => boolean
  tree?: ClaudeChildTreeReaper
  managed?: ManagedProviderProcess
  /** The child is the POSIX provider supervisor: SIGTERM stops Claude, which reaps its tools. */
  supervised?: boolean
}

export async function proveClaudeChildExitWithReaper(
  input: ClaudeChildExitProofInput,
  createTree: () => ClaudeChildTreeReaper
): Promise<boolean> {
  const tree = input.tree ?? createTree()
  if (input.managed) {
    return (await input.managed.close(tree)) === 'exited'
  }
  const result = await closeProviderProcess({
    ...input,
    tree,
    policy: claudeChildClosePolicy(input.supervised ?? false),
    terminateTree: async () => false
  })
  return result.verdict === 'exited'
}
