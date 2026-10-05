/**
 * `orca environment status|update|rollback|recover|stop|cancel-stop`: the Managed servers
 * actions over runtime RPC. Each call is gated on the runtime's managedServer.v1 capability, and
 * an older runtime's method_not_found reads the same as a missing capability.
 */
import type {
  OrcadManagedCancelStopResult,
  OrcadManagedDeployResult,
  OrcadManagedRecoveryResult,
  OrcadManagedRollbackResult,
  OrcadManagedRuntimeStatus,
  OrcadManagedStopResult
} from '../../shared/orcad-managed-runtime'
import { MANAGED_SERVER_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import { formatManagedServerStatus } from './managed-server-format'

const UNSUPPORTED_MESSAGE =
  'This Orca runtime cannot manage servers over SSH. Run this on the computer whose Orca desktop app deployed the server, after updating Orca there.'

function unsupported(): RuntimeClientError {
  return new RuntimeClientError('incompatible_runtime', UNSUPPORTED_MESSAGE)
}

async function callManagedServer<TResult>(
  { client }: HandlerContext,
  method: string,
  params: Record<string, unknown>
): Promise<RuntimeRpcSuccess<TResult>> {
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(MANAGED_SERVER_RUNTIME_CAPABILITY)) {
    throw unsupported()
  }
  try {
    return await client.call<TResult>(method, params)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw unsupported()
    }
    throw error
  }
}

function selectorOf(context: HandlerContext): { selector: string } {
  return { selector: getRequiredStringFlag(context.flags, 'environment') }
}

type Outcome = { outcome: string; code?: string; reason?: string }

/**
 * Prints a result whose outcome is in `settled`; throws any other so scripts see a non-zero exit.
 * Why an allow-list: an outcome a newer desktop adds must fail loudly, not print `undefined`.
 */
function report<TResult extends Outcome, TSettled extends TResult['outcome']>(
  response: RuntimeRpcSuccess<TResult>,
  json: boolean,
  settled: readonly TSettled[],
  done: (result: Extract<TResult, { outcome: TSettled }>) => string
): void {
  const result = response.result
  if (!isSettled(result, settled)) {
    throw new RuntimeClientError(
      `managed_server_${result.outcome}`,
      result.reason ?? `The managed Orca server action was ${result.outcome}.`,
      result
    )
  }
  printResult({ ...response, result }, json, done)
}

function isSettled<TResult extends Outcome, TSettled extends TResult['outcome']>(
  result: TResult,
  settled: readonly TSettled[]
): result is Extract<TResult, { outcome: TSettled }> {
  return settled.some((outcome) => outcome === result.outcome)
}

export const MANAGED_SERVER_HANDLERS: Record<string, CommandHandler> = {
  'environment status': async (context) => {
    const response = await callManagedServer<OrcadManagedRuntimeStatus>(
      context,
      'managedServer.status',
      selectorOf(context)
    )
    printResult(response, context.json, formatManagedServerStatus)
  },
  'environment update': async (context) => {
    const params = { ...selectorOf(context), force: context.flags.get('force') === true }
    const response = await callManagedServer<OrcadManagedDeployResult>(
      context,
      'managedServer.update',
      params
    )
    report(response, context.json, ['created', 'updated', 'already-current'], (result) =>
      result.outcome === 'already-current'
        ? `Already on ${result.activeVersion}.`
        : `Updated ${result.environment.name} to ${result.activeVersion}.`
    )
  },
  'environment rollback': async (context) => {
    const response = await callManagedServer<OrcadManagedRollbackResult>(
      context,
      'managedServer.rollback',
      selectorOf(context)
    )
    report(
      response,
      context.json,
      ['rolled-back'],
      (result) => `Rolled ${result.environment.name} back to ${result.activeVersion}.`
    )
  },
  'environment recover': async (context) => {
    const response = await callManagedServer<OrcadManagedRecoveryResult>(
      context,
      'managedServer.recover',
      selectorOf(context)
    )
    report(response, context.json, ['recovered', 'none'], (result) =>
      result.outcome === 'recovered'
        ? `Recovered ${result.environment.name} (${result.resolution}); active version ${result.activeVersion ?? 'none'}.`
        : 'Nothing to recover.'
    )
  },
  'environment stop': async (context) => {
    const params = selectorOf(context)
    if (context.flags.get('yes') !== true) {
      throw new RuntimeClientError(
        'confirmation_required',
        `Stopping ${params.selector} ends its terminals and unlinks it from this machine. Re-run with --yes to confirm.`
      )
    }
    const response = await callManagedServer<OrcadManagedStopResult>(
      context,
      'managedServer.stop',
      params
    )
    report(
      response,
      context.json,
      ['unlinked'],
      () => `Stopped ${params.selector} and unlinked it from this machine.`
    )
  },
  'environment cancel-stop': async (context) => {
    const response = await callManagedServer<OrcadManagedCancelStopResult>(
      context,
      'managedServer.cancelStop',
      selectorOf(context)
    )
    report(response, context.json, ['canceled', 'already-stopped', 'none'], (result) => {
      switch (result.outcome) {
        case 'canceled':
          return `Stop withdrawn; the server keeps serving ${result.activeVersion}.`
        case 'already-stopped':
          return 'orcad had already exited. Run `orca environment stop --yes` to unlink it.'
        case 'none':
          return 'No stop is pending.'
      }
    })
  }
}
