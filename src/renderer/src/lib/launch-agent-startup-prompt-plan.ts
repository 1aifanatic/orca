import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'
import { planStartupWithLaunchPrompt } from '../../../shared/startup-line-prompt-carry'
import type { LaunchFile } from '../../../shared/launch-prompt-file'

type StartupPlanBase = Omit<
  Parameters<typeof buildAgentStartupPlan>[0],
  'prompt' | 'allowEmptyPromptLaunch'
>

export type LaunchAgentStartupPromptPlan = {
  startupPlan: AgentStartupPlan | null
  /** Written by the host before it types the launch line naming it. */
  launchFile?: LaunchFile
  /** Text to paste once the TUI is ready; null when the launch command already carries it. */
  pasteDraftAfterLaunch: string | null
  submitPastedPrompt: boolean
}

/**
 * Decide how a new-tab launch delivers its prompt: agents whose CLI takes one get it on the launch
 * command, while agents that take text only after start launch clean and paste once ready.
 */
export function planLaunchAgentStartupPrompt(args: {
  base: StartupPlanBase
  /** Already trimmed. */
  prompt: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  isFollowupPath: boolean
  /** A paired host of unknown version may neither stage a long line nor write a launch file. */
  launchesOnPairedHost: boolean
}): LaunchAgentStartupPromptPlan {
  const { base, prompt, promptDelivery, isFollowupPath } = args
  const hasPrompt = prompt.length > 0
  const pasteAfterReady = (submit: boolean): LaunchAgentStartupPromptPlan => ({
    startupPlan: buildAgentStartupPlan({ ...base, prompt: '', allowEmptyPromptLaunch: true }),
    pasteDraftAfterLaunch: prompt,
    submitPastedPrompt: submit
  })

  if (hasPrompt && promptDelivery === 'draft') {
    const draftLaunchPlan = buildAgentDraftLaunchPlan({ ...base, draft: prompt })
    if (!draftLaunchPlan) {
      return pasteAfterReady(false)
    }
    return {
      startupPlan: {
        agent: draftLaunchPlan.agent,
        launchCommand: draftLaunchPlan.launchCommand,
        expectedProcess: draftLaunchPlan.expectedProcess,
        followupPrompt: null,
        launchConfig: draftLaunchPlan.launchConfig,
        ...(draftLaunchPlan.sessionOptions
          ? { sessionOptions: draftLaunchPlan.sessionOptions }
          : {}),
        ...(draftLaunchPlan.startupCommandDelivery
          ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
          : {}),
        ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
      },
      pasteDraftAfterLaunch: null,
      submitPastedPrompt: false
    }
  }
  // Temporary, until paired hosts advertise staging: keep their paste after readiness.
  if (
    hasPrompt &&
    (isFollowupPath || (args.launchesOnPairedHost && promptDelivery === 'submit-after-ready'))
  ) {
    return pasteAfterReady(promptDelivery === 'submit-after-ready')
  }
  if (!hasPrompt || args.launchesOnPairedHost) {
    const startupPlan = buildAgentStartupPlan({
      ...base,
      prompt,
      allowEmptyPromptLaunch: !hasPrompt
    })
    // A paired host is sent a command, never a launch file, so a prompt that needs one is pasted.
    return startupPlan?.launchFile
      ? pasteAfterReady(true)
      : { startupPlan, pasteDraftAfterLaunch: null, submitPastedPrompt: false }
  }
  const carried = planStartupWithLaunchPrompt(base, prompt)
  return {
    startupPlan: carried.plan,
    ...(carried.launchFile ? { launchFile: carried.launchFile } : {}),
    pasteDraftAfterLaunch: null,
    submitPastedPrompt: false
  }
}
