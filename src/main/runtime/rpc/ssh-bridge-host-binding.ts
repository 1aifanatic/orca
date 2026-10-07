/**
 * Keeps an SSH host's relayed `orca` CLI inside that host's own terminals.
 *
 * Without the per-target opt-in, the bridge reaches only these methods, and each selector must
 * resolve to a terminal on the bridged host; orchestration callers are bound the same way. Terminals whose host cannot be named are refused:
 * failing closed is the only safe answer for a credential that must not reach other hosts.
 */
import { toSshExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeTerminalListResult } from '../../../shared/runtime-terminal-contracts'
import {
  findSshBridgeOrchestrationViolation,
  readStringParam,
  SSH_BRIDGE_ORCHESTRATION_METHODS,
  type SshBridgeOrchestrationRuntime
} from './ssh-bridge-orchestration-binding'

const TERMINAL_HANDLE_METHODS: ReadonlySet<string> = new Set([
  'terminal.show',
  'terminal.read',
  'terminal.send',
  'terminal.wait'
])

export const SSH_BRIDGE_HOST_BOUND_METHODS: ReadonlySet<string> = new Set([
  'status.get',
  'terminal.list',
  ...TERMINAL_HANDLE_METHODS,
  ...SSH_BRIDGE_ORCHESTRATION_METHODS
])

export type SshBridgeHostBindingRuntime = SshBridgeOrchestrationRuntime & {
  showTerminal(handle: string): Promise<{ executionHostId?: ExecutionHostId }>
}

export type SshBridgeResultFilter = (
  result: unknown
) => { kind: 'denied'; message: string } | { kind: 'allowed'; result: unknown }

export type SshBridgeCallBinding =
  | { kind: 'denied'; message: string }
  | { kind: 'allowed'; filterResult?: SshBridgeResultFilter }

export async function bindSshBridgeCall(
  runtime: SshBridgeHostBindingRuntime,
  targetId: string,
  methodName: string,
  params: unknown
): Promise<SshBridgeCallBinding> {
  const hostId = toSshExecutionHostId(targetId)
  if (TERMINAL_HANDLE_METHODS.has(methodName)) {
    const handle = readStringParam(params, 'terminal')
    const terminalHostId = handle ? await resolveTerminalHost(runtime, handle) : null
    return terminalHostId === hostId
      ? { kind: 'allowed' }
      : { kind: 'denied', message: outsideHostMessage(targetId, `terminal '${handle ?? ''}'`) }
  }
  if (SSH_BRIDGE_ORCHESTRATION_METHODS.has(methodName)) {
    const violation = await findSshBridgeOrchestrationViolation(
      runtime,
      async (handle) => (await resolveTerminalHost(runtime, handle)) === hostId,
      methodName,
      params
    )
    return violation
      ? { kind: 'denied', message: outsideHostMessage(targetId, violation) }
      : { kind: 'allowed' }
  }
  if (methodName === 'terminal.list') {
    const worktree = readStringParam(params, 'worktree')
    return {
      kind: 'allowed',
      filterResult: (result) => filterTerminalListToHost(result, targetId, worktree)
    }
  }
  return { kind: 'allowed' }
}

async function resolveTerminalHost(
  runtime: SshBridgeHostBindingRuntime,
  handle: string
): Promise<ExecutionHostId | null> {
  try {
    return (await runtime.showTerminal(handle)).executionHostId ?? null
  } catch {
    return null
  }
}

function filterTerminalListToHost(
  result: unknown,
  targetId: string,
  worktreeSelector: string | null
): ReturnType<SshBridgeResultFilter> {
  const hostId = toSshExecutionHostId(targetId)
  if (!isTerminalListResult(result)) {
    return { kind: 'denied', message: 'Terminal listing could not be scoped to the SSH host.' }
  }
  const terminals = result.terminals.filter((terminal) => terminal.executionHostId === hostId)
  if (worktreeSelector && terminals.length !== result.terminals.length) {
    return {
      kind: 'denied',
      message: outsideHostMessage(targetId, `worktree '${worktreeSelector}'`)
    }
  }
  const worktreeIds = new Set(terminals.map((terminal) => terminal.worktreeId))
  const scoped: RuntimeTerminalListResult = {
    terminals,
    totalCount: terminals.length,
    truncated: result.truncated && terminals.length === result.terminals.length,
    ...(result.visualLayouts
      ? {
          visualLayouts: result.visualLayouts.filter((layout) => worktreeIds.has(layout.worktreeId))
        }
      : {}),
    ...(result.topologyRevisions
      ? {
          topologyRevisions: Object.fromEntries(
            Object.entries(result.topologyRevisions).filter(([worktreeId]) =>
              worktreeIds.has(worktreeId)
            )
          )
        }
      : {}),
    ...(result.hostScope
      ? {
          hostScope: {
            hostIds: result.hostScope.hostIds.filter((id) => id === hostId),
            omittedHostIds: result.hostScope.omittedHostIds.filter((id) => id === hostId)
          }
        }
      : {})
  }
  return { kind: 'allowed', result: scoped }
}

function isTerminalListResult(value: unknown): value is RuntimeTerminalListResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'terminals' in value &&
    Array.isArray(value.terminals) &&
    'truncated' in value &&
    typeof value.truncated === 'boolean'
  )
}

function outsideHostMessage(targetId: string, subject: string): string {
  return `The orca CLI on SSH host '${targetId}' can only reach that host's own terminals and the coordinator that dispatched them, and ${subject} is outside that. To let that host's CLI control this Orca, enable "Allow this host's orca CLI to control Orca" in Settings > SSH for that host.`
}
