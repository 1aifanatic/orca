import type { AgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'
import type { CodexApprovalsReviewer } from '../../shared/codex-subagent-reviewer'

export type CodexStructuredPermissionPolicy =
  | { approvalPolicy: 'never'; sandbox: 'danger-full-access' }
  | {
      approvalPolicy: 'on-request'
      sandbox: 'workspace-write'
      approvalsReviewer: CodexApprovalsReviewer
    }

/** Full access: no approval prompts, no sandbox. */
const BYPASS_POLICY = { approvalPolicy: 'never', sandbox: 'danger-full-access' } as const

/**
 * Ask for approval: approvals on, writes confined to the workspace, a person reviews.
 *
 * Why state it rather than omit it, which is what Manual used to do: app-server resolves an
 * omitted field through the `config.toml` it was started with, and Orca mirrors the user's
 * `~/.codex/config.toml` into the managed home it hands the app-server. Measured against codex
 * 0.153.4 — with `approval_policy = "never"` in that file, a FRESH Manual thread comes up
 * `never` + `dangerFullAccess` and never prompts. Manual was not a posture at all; it was
 * "inherit whatever the config says". A resume additionally inherits the policy the thread was
 * last started with, which is the path the bug was reported on; that half is not isolated here,
 * because staging a real Yolo thread needs a live turn before codex writes the rollout.
 *
 * Why `workspace-write` and not codex's built-in `read-only`: read-only would override a
 * deliberate `sandbox_mode = "workspace-write"` and make every file write in a Manual session
 * need an approval it did not need before. This still resets Yolo's `danger-full-access`.
 *
 * The reviewer is stated for the same reason: `approvals_reviewer = "auto_review"` in the config
 * would otherwise route a Manual chat's approvals to Codex's own reviewer.
 */
const ASK_POLICY = {
  approvalPolicy: 'on-request',
  sandbox: 'workspace-write',
  approvalsReviewer: 'user'
} as const

/** Approve for me: Ask's sandbox and approvals, reviewed by Codex's auto-review agent. */
const AUTO_POLICY = { ...ASK_POLICY, approvalsReviewer: 'auto_review' } as const

/**
 * A chat's permission mode as app-server thread policy. Always a policy, never `undefined`: every
 * mode has to be said out loud, because the one that goes unsaid is the one a resume silently
 * inherits from the other. Codex has no edits-only mode; a stray `accept-edits` asks.
 */
export function codexStructuredPermissionPolicy(
  mode: AgentChatPermissionMode
): CodexStructuredPermissionPolicy {
  return mode === 'bypass' ? BYPASS_POLICY : mode === 'auto' ? AUTO_POLICY : ASK_POLICY
}
