import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { NewTabPromptDeliveryResult } from '@/lib/launch-agent-new-tab-host-route'
import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import type { AgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentLaunchFollowUp } from '../../../shared/agent-launch-follow-up'
import type { LaunchSource } from '../../../shared/telemetry-events'

/** The user action this launch serves: minted where that action is handled, or carried by the
 *  route the caller already planned for it. */
type LaunchAgentInNewTabRequest =
  | { requestId: AgentLaunchRequestId; agentSessionLaunchPlan?: undefined }
  | {
      /** Keeps a preflighted route authoritative across workspace creation. */
      agentSessionLaunchPlan: AgentSessionLaunchPlan
      requestId?: undefined
    }

export type LaunchAgentInNewTabArgs = LaunchAgentInNewTabRequest & {
  agent: TuiAgent
  /** Existing-session context helpers retain their current delivery path. */
  launchPurpose?: 'session-continuation' | 'session-fork'
  worktreeId: string
  /** Tab group the user launched from; keeps split-group launches in that pane instead of the active group. */
  groupId?: string
  /** Optional initial prompt; delivery depends on `promptDelivery` and the agent's prompt mode. */
  prompt?: string
  /** Optional CLI arguments appended to the selected agent command. */
  agentArgs?: string | null
  initialCwd?: string | null
  /** How to deliver the prompt: `draft` leaves it editable, `submit-after-ready` sends it once the TUI is ready. */
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  /** Telemetry surface that initiated this launch. Defaults to the tab-bar quick-launch entry point. */
  launchSource?: LaunchSource
  /** User-authored Quick Command label for local tabs created from the tab bar. */
  quickCommandLabel?: string | null
  /** Shell platform for the startup command; defaults to renderer OS. SSH/WSL worktrees run Linux even from Windows. */
  launchPlatform?: NodeJS.Platform
  /** Called after the prompt is actually delivered to the agent input path. */
  onPromptDelivered?: () => void
  /**
   * Called before `onPromptDelivered` when the paste was written without ever observing the
   * agent's composer, so the launch cannot claim the prompt arrived. Fires only on the
   * terminal route, whose readiness signal the client watches itself.
   */
  onPromptDeliveryUnconfirmed?: () => void
  /** What `onPromptDelivered` does, recorded on a host launch so a reload mid-launch still runs it
   *  once (`agent-launch-follow-ups`). */
  durableFollowUp?: AgentLaunchFollowUp
  /** Keep terminal launches in a floating workspace from taking global selection. */
  activate?: boolean
  /** The launch seeds a workspace being opened, so its PTY spawn must not reshuffle Recent. */
  pendingActivationSpawn?: boolean
  /** Lets a workspace reveal itself before the selected surface opens. */
  beforeSurfaceOpen?: (
    surface:
      | { kind: 'local-terminal' }
      | { kind: 'local-agent-session'; sessionId: string }
      | { kind: 'host-published' }
  ) => boolean | void
}

export type AgentLaunchSurface =
  | { kind: 'local-terminal'; tabId: string }
  | { kind: 'local-agent-session'; tabId: string; sessionId: string }
  | { kind: 'host-published' }

export type LaunchAgentInNewTabResult = {
  surface: AgentLaunchSurface
  startupPlan: AgentStartupPlan
  pasteDraftAfterLaunch: boolean
  promptDeliveryResult?: Promise<NewTabPromptDeliveryResult>
  /** Structured route only: what the launch did once it settled. The call stays synchronous. */
  structuredSettlement?: Promise<StructuredAgentLaunchSettlement>
} | null
