/**
 * The `agent.launch` operations this process is running, by ledger key: a retry under the same id
 * joins the running one across window reloads.
 */

import type { AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { AgentLaunchView } from './agent-launch-tab-publication'

type AgentLaunchOwner = Pick<OrcaRuntimeService, 'openedAgentSessionRecordStore'>

type ActiveAgentLaunch = {
  fingerprint: string
  promise: Promise<AgentLaunchResult>
  /** Optional desktop admission can continue past capacity; strict replay still joins `promise`. */
  desktopRequest?: Promise<AgentLaunchResult>
  requestDesktop?: () => Promise<AgentLaunchResult>
}

const activeAgentLaunchesByRuntime = new WeakMap<AgentLaunchOwner, Map<string, ActiveAgentLaunch>>()

export function activeAgentLaunchesFor(runtime: AgentLaunchOwner): Map<string, ActiveAgentLaunch> {
  const existing = activeAgentLaunchesByRuntime.get(runtime)
  if (existing) {
    return existing
  }
  const active = new Map<string, ActiveAgentLaunch>()
  activeAgentLaunchesByRuntime.set(runtime, active)
  return active
}

export function joinActiveAgentLaunch(args: {
  runtime: OrcaRuntimeService
  key: string
  fingerprint: string
  desktopRequest: boolean
  execute: (preserveCapacityTab?: (view: AgentLaunchView) => boolean) => Promise<AgentLaunchResult>
  capacityFallback?: (view: AgentLaunchView) => Promise<AgentLaunchResult>
  onSettled: () => void
}): Promise<AgentLaunchResult> {
  const active = activeAgentLaunchesFor(args.runtime)
  const existing = active.get(args.key)
  if (existing) {
    if (existing.fingerprint !== args.fingerprint) {
      return Promise.reject(new Error('agent_session_operation_conflict'))
    }
    return args.desktopRequest
      ? (existing.requestDesktop?.() ?? existing.promise)
      : existing.promise
  }
  let capacityView: AgentLaunchView | undefined
  let desktopRequest: Promise<AgentLaunchResult> | undefined
  const cleanup = () => {
    if (active.get(args.key)?.promise === promise) {
      active.delete(args.key)
    }
    args.onSettled()
  }
  const promise = args
    .execute(
      args.capacityFallback
        ? (view) => {
            if (!desktopRequest) {
              return false
            }
            capacityView = view
            return true
          }
        : undefined
    )
    .finally(() => {
      if (!desktopRequest) {
        cleanup()
      }
    })
  const requestDesktop = () => {
    if (!desktopRequest) {
      desktopRequest = promise
        .catch((error: unknown) => {
          if (!capacityView || !args.capacityFallback) {
            throw error
          }
          return args.capacityFallback(capacityView)
        })
        .finally(cleanup)
      const entry = active.get(args.key)
      if (entry?.promise === promise) {
        entry.desktopRequest = desktopRequest
      }
    }
    return desktopRequest
  }
  active.set(args.key, {
    fingerprint: args.fingerprint,
    promise,
    ...(args.capacityFallback ? { requestDesktop } : {})
  })
  return args.desktopRequest ? requestDesktop() : promise
}
