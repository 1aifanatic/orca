import type { SessionOptionValue } from '../../shared/native-chat-session-options'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { resolveBareAgentLaunchCommand } from './runtime-agent-launch-resolution'
import { planExecutionHostStartupWithPromptCandidate } from '../opencode/opencode-model-startup-plan'
import { agentPromptRidesLaunchCommand } from '../../shared/tui-agent-startup'
import {
  launchHostProvesAgentInFront,
  nameLocalTypedLineShell
} from './agent-launch-typed-line-shell'
import { resolveTerminalStartupCwd } from '../../shared/terminal-startup-cwd'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import { agentStartedTelemetry } from '../agent-launch/agent-started-telemetry'
import { planLaunchAgentStartupPrompt } from '../../shared/launch-agent-startup-prompt-plan'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'

export async function buildRuntimeAgentTerminalStartupOptions(
  workspace: TerminalWorkspaceLaunchScope,
  opts: TerminalCreateOptions,
  settings: ReturnType<RuntimeStore['getSettings']>,
  platform: NodeJS.Platform,
  sessionOptions: Record<string, SessionOptionValue> | undefined,
  hostIdentity: string
): Promise<TerminalCreateOptions> {
  // Why: `workspace.repo` is display metadata and may be a row from another host; the launch
  // shape must match the PTY route this scope already resolved.
  const isRemote = Boolean(workspace.connectionId)
  if (opts.startupAgent && !isTuiAgentEnabled(opts.startupAgent, settings.disabledTuiAgents)) {
    throw new Error(`Agent ${opts.startupAgent} is disabled. Choose an enabled agent.`)
  }
  const agent =
    opts.startupAgent ??
    resolveBareAgentLaunchCommand({
      command: opts.command,
      settings,
      platform,
      isRemote
    })
  if (!agent) {
    return opts
  }

  if (opts.desktopPrompt) {
    const selected = planLaunchAgentStartupPrompt({
      base: {
        ...resolveAgentStartupPlanInputs({
          agent,
          settings,
          platform,
          isRemote,
          ...(opts.agentArgs !== undefined ? { agentArgs: opts.agentArgs } : {}),
          windowsShellOverride: opts.shellOverride,
          sessionOptions: opts.desktopSessionOptions
        }),
        // Main's desktop builder lets trailing arguments override session options.
        sessionOptionsOverrideAgentArgs: false
      },
      prompt: opts.desktopPrompt.text.trim(),
      promptDelivery: opts.desktopPrompt.transport.promptDelivery,
      isFollowupPath: TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
    })
    const plan = selected.startupPlan
    if (!plan) {
      throw new Error(`Could not build launch command for ${agent}.`)
    }
    opts.onStartupPromptCarry?.(
      Boolean(opts.desktopPrompt.text.trim()) && selected.pasteDraftAfterLaunch === null
    )
    return {
      ...opts,
      command: plan.launchCommand,
      ...(plan.env ? { env: plan.env } : {}),
      launchConfig: plan.launchConfig,
      launchAgent: agent,
      startupCommandDelivery: plan.startupCommandDelivery,
      ...(opts.startupAgent ? { telemetry: agentStartedTelemetry(agent, opts.launchSource) } : {})
    }
  }

  // A prompt this launch command cannot carry has nowhere to go from here — the create returns
  // options, not a live PTY — so refuse rather than spawn the agent and drop the text.
  if (opts.startupPrompt && !agentPromptRidesLaunchCommand(agent)) {
    throw new Error(`Agent ${agent} does not take a startup prompt on its launch command.`)
  }
  const { plan: startupPlan, promptCarried } = await planExecutionHostStartupWithPromptCandidate({
    inputs: resolveAgentStartupPlanInputs({
      agent,
      settings,
      platform,
      isRemote,
      ...(opts.agentArgs !== undefined ? { agentArgs: opts.agentArgs } : {}),
      // A requested shell is the one this PTY will actually be, so it owns the quoting family.
      windowsShellOverride: opts.shellOverride,
      sessionOptions: sessionOptions
    }),
    prompt: opts.startupPrompt ?? '',
    cwd: resolveTerminalStartupCwd(workspace.path, opts.cwd) ?? workspace.path,
    hostIdentity,
    host: {
      shellName: nameLocalTypedLineShell({
        isRemote,
        ...(opts.shellOverride ? { shellOverride: opts.shellOverride } : {}),
        ...(settings.terminalDefaultShell
          ? { defaultShellSetting: settings.terminalDefaultShell }
          : {})
      }),
      provesAgentInFront: launchHostProvesAgentInFront({ isRemote, launchPlatform: platform })
    }
  })
  if (!startupPlan) {
    // Why: an explicit agent that yields no plan would otherwise spawn a bare
    // shell that never reaches agent readiness.
    if (opts.startupAgent) {
      throw new Error(`Could not build launch command for ${opts.startupAgent}.`)
    }
    return opts
  }
  if (opts.startupPrompt) {
    opts.onStartupPromptCarry?.(promptCarried)
  }

  return {
    ...opts,
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    launchAgent: agent,
    startupCommandDelivery: startupPlan.startupCommandDelivery,
    // A bare command the user typed stays out of launch accounting, as before.
    ...(opts.startupAgent ? { telemetry: agentStartedTelemetry(agent, opts.launchSource) } : {})
  }
}
