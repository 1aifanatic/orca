/**
 * Creating a workspace with its agent the way `worktree.create` always has, through the executor.
 *
 * The agent is the workspace's startup terminal, never a chat, and the create delivers the text
 * itself; that is `worktree.create`'s contract, so the launch is `terminalOnly` with the
 * `legacy-host` prompt policy. Request and result are the create's own, so a caller swaps
 * `runtime.createManagedWorktree` for this and nothing a client sends or reads changes.
 */

import type { AgentLaunchPrompt } from '../../shared/agent-launch-intent'
import type { TuiAgent } from '../../shared/tui-agent'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeManagedWorktreeCreateArgs } from '../runtime/runtime-managed-worktree-create-types'
import { executeAgentLaunch, type AgentLaunchExecution } from './agent-launch-executor'
import { AgentLaunchStartupAgentNotCreatedError } from './agent-launch-surface-factories'

type StartupAgentCreateRuntime = AgentLaunchExecution['runtime'] &
  Pick<OrcaRuntimeService, 'createManagedWorktree' | 'showRepo' | 'resolveStartupDraftAgent'>

export async function createWorktreeWithStartupAgent(
  runtime: StartupAgentCreateRuntime,
  args: RuntimeManagedWorktreeCreateArgs
): Promise<CreateWorktreeResult> {
  const launch = await resolveStartupAgentLaunch(runtime, args)
  if (!launch) {
    return runtime.createManagedWorktree(args)
  }
  let created: CreateWorktreeResult | undefined
  try {
    await executeAgentLaunch({
      runtime,
      intent: {
        agent: launch.agent,
        target: { kind: 'create-worktree', create: args },
        ...(launch.prompt ? { prompt: launch.prompt } : {}),
        ...(args.startupLaunchSource ? { launchSource: args.startupLaunchSource } : {})
      },
      terminalOnly: true,
      promptPolicy: 'legacy-host',
      workspaces: {
        // Reads the typed request it was built from; the executor's `create` is the same minus the
        // agent fields, which come back as arguments here.
        createWorktree: async ({ startupAgent, legacyPrompt, launchSource }) => {
          created = await runtime.createManagedWorktree({
            ...withoutStartupAgentFields(args),
            ...legacyStartupFields(startupAgent, legacyPrompt),
            ...(launchSource ? { startupLaunchSource: launchSource } : {})
          })
          return {
            worktreeId: created.worktree.id,
            connectionId: launch.connectionId,
            startupTerminalHandle: created.startupTerminal?.handle,
            ...(created.startupTerminal?.paneKey
              ? { startupTerminalPaneKey: created.startupTerminal.paneKey }
              : {}),
            ...(created.warning ? { warning: created.warning } : {})
          }
        }
      }
    })
  } catch (error) {
    // A workspace with no agent back is the answer `worktree.create` has always given here.
    if (!(error instanceof AgentLaunchStartupAgentNotCreatedError) || !created) {
      throw error
    }
  }
  if (!created) {
    throw new Error('agent_launch_workspace_not_created')
  }
  return created
}

/** The launch a create asks for, or null when it starts no agent. Mirrors the create's own order: a
 *  prebuilt command wins, then `startupAgent`, then a linked draft's agent. */
async function resolveStartupAgentLaunch(
  runtime: StartupAgentCreateRuntime,
  args: RuntimeManagedWorktreeCreateArgs
): Promise<{
  agent: TuiAgent
  prompt: AgentLaunchPrompt | undefined
  connectionId: string | null
} | null> {
  if (args.startup || (!args.startupAgent && !args.startupDraft?.trim())) {
    return null
  }
  const repo = await runtime.showRepo(args.repoSelector)
  const connectionId = repo.connectionId ?? null
  if (args.startupAgent) {
    return {
      agent: args.startupAgent,
      // An empty prompt is still the caller's; the create launches the agent bare for it.
      prompt:
        args.startupPrompt !== undefined
          ? { text: args.startupPrompt, delivery: 'submit' }
          : undefined,
      connectionId
    }
  }
  const agent = await runtime.resolveStartupDraftAgent(repo, args.createdWithAgent)
  return agent
    ? {
        agent,
        prompt: { text: args.startupDraft ?? '', delivery: 'draft' },
        connectionId
      }
    : null
}

/** A draft starts its agent through `startupDraft`, which a `startupAgent` would override. */
function legacyStartupFields(
  agent: TuiAgent | undefined,
  prompt: AgentLaunchPrompt | undefined
): Partial<RuntimeManagedWorktreeCreateArgs> {
  if (!agent) {
    throw new Error('agent_launch_legacy_create_requires_terminal')
  }
  if (prompt?.delivery === 'draft') {
    return { createdWithAgent: agent, startupDraft: prompt.text }
  }
  return {
    startupAgent: agent,
    ...(prompt ? { startupPrompt: prompt.text } : {})
  }
}

function withoutStartupAgentFields(
  args: RuntimeManagedWorktreeCreateArgs
): RuntimeManagedWorktreeCreateArgs {
  const {
    startupAgent: _agent,
    startupPrompt: _prompt,
    startupDraft: _draft,
    startupLaunchSource: _source,
    ...rest
  } = args
  return rest
}
