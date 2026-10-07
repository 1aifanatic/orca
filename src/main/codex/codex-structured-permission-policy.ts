import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolvedTuiAgentArgsBypassPermissions } from '../../shared/tui-agent-launch-defaults'

// The values app-server's v2 thread params accept (`AskForApproval` / `SandboxMode` /
// `ApprovalsReviewer`).
export const CODEX_APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'] as const
export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export const CODEX_APPROVALS_REVIEWERS = ['user', 'auto_review'] as const

export type CodexStructuredPermissionPolicy = {
  approvalPolicy: (typeof CODEX_APPROVAL_POLICIES)[number]
  sandbox: (typeof CODEX_SANDBOX_MODES)[number]
  approvalsReviewer: (typeof CODEX_APPROVALS_REVIEWERS)[number]
}

/** Yolo: no approval prompts, no sandbox. */
const BYPASS_POLICY = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  approvalsReviewer: 'user'
} as const

/**
 * Manual: approvals on, writes confined to the workspace.
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
 * The reviewer is stated too, as Codex's default `user`: a resume otherwise keeps the reviewer
 * the thread last ran with, e.g. `auto_review` after `--approve-for-me` was removed.
 */
const MANUAL_POLICY = {
  approvalPolicy: 'on-request',
  sandbox: 'workspace-write',
  approvalsReviewer: 'user'
} as const

/**
 * The Agent Permissions setting as app-server thread policy.
 *
 * The posture is the one the toggle stores in the Arguments field; an untouched profile resolves
 * to the default Orca ships, which is the bypass flag. Under Manual, a sandbox, approval policy or
 * reviewer the Arguments state explicitly (`requested`) replaces that field's default, as it does
 * in a terminal; Yolo ignores it.
 *
 * Always a policy, never `undefined`: both postures have to be said out loud, because the one
 * that goes unsaid is the one a resume silently inherits from the other.
 */
export function codexStructuredPermissionPolicyForSettings(
  settings:
    | Partial<Pick<GlobalSettings, 'agentDefaultArgs' | 'terminalWindowsShell'>>
    | null
    | undefined,
  requested: Partial<CodexStructuredPermissionPolicy> = {}
): CodexStructuredPermissionPolicy {
  return resolvedTuiAgentArgsBypassPermissions('codex', settings, process.platform)
    ? BYPASS_POLICY
    : { ...MANUAL_POLICY, ...requested }
}
