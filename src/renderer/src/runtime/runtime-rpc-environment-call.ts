import { callAbortableRuntimeEnvironment } from './abortable-runtime-environment-call'
import { refreshRuntimeEnvironmentsAfterPairingChange } from './runtime-environment-pairing-refresh'

export async function callRuntimeEnvironmentWithRevision(
  args: Parameters<typeof callRuntimeEnvironmentOnce>[0]
): Promise<unknown> {
  try {
    return await callRuntimeEnvironmentOnce(args)
  } catch (error) {
    void refreshRuntimeEnvironmentsAfterPairingChange(error)
    throw error
  }
}

async function callRuntimeEnvironmentOnce(args: {
  environmentId: string
  method: string
  params: unknown
  timeoutMs?: number
  signal?: AbortSignal
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
}): Promise<unknown> {
  if (args.signal) {
    return callAbortableRuntimeEnvironment(
      args.environmentId,
      args.method,
      args.params,
      args.timeoutMs,
      args.signal,
      args.expectedEnvironmentPairingRevision,
      args.expectedEnvironmentRuntimeId
    )
  }
  return window.api.runtimeEnvironments.call({
    selector: args.environmentId,
    method: args.method,
    params: args.params,
    timeoutMs: args.timeoutMs,
    expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision,
    expectedEnvironmentRuntimeId: args.expectedEnvironmentRuntimeId
  })
}
