import { prepareFederationAttachmentWorkerStart } from './worker-start-validation'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

export async function probeWorkerOpenCodeModelLaunchSupport(
  runtime: OrcaRuntimeService,
  params: { agent?: string; model?: string },
  target: { worktree?: string; repo?: string }
): Promise<boolean> {
  return Boolean(
    params.model &&
    params.agent &&
    runtime.resolveOrchestrationAgentLauncher(params.agent) === 'opencode' &&
    (await runtime.probeOrchestrationOpenCodeModelLaunchSupport({ ...target, model: params.model }))
  )
}

export async function prepareFederationWorkerLaunchOnHost(
  args: Omit<
    Parameters<typeof prepareFederationAttachmentWorkerStart>[0],
    'openCodeModelLaunchSupported'
  >
) {
  const openCodeModelLaunchSupported = await probeWorkerOpenCodeModelLaunchSupport(
    args.runtime,
    args.params,
    args.createsWorktree ? { repo: args.params.repo } : { worktree: args.params.worktree }
  )
  return prepareFederationAttachmentWorkerStart({ ...args, openCodeModelLaunchSupported })
}
