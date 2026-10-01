import type { ClaudeProfileReadiness } from '../../shared/managed-account-types'
import type { ClaudeProfileDescriptor } from './claude-profile-paths'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'

export type ClaudeProfileLaunchDescriptor = {
  profile: ClaudeProfileDescriptor | null
  /** Paths belong to the execution host; readHome may be the host's UNC access path. */
  configHome: string
  readHome: string
  defaultHome: string
  pointerPath: string
  target: ClaudeAccountSelectionTarget
}

export type ClaudeProfileRoutingOwner = {
  resolve: (target?: ClaudeAccountSelectionTarget) => ClaudeProfileLaunchDescriptor
  refresh?: (target?: ClaudeAccountSelectionTarget) => Promise<void>
  pointerPath: (target?: ClaudeAccountSelectionTarget) => string
  targets: () => ClaudeAccountSelectionTarget[]
  /** All known owned profiles, including unselected profiles with private/retained history. */
  readHomes: (
    target?: ClaudeAccountSelectionTarget,
    surface?: 'projects' | 'transcripts'
  ) => string[]
  capabilities: (target: ClaudeAccountSelectionTarget) => readonly string[]
  /** Derived from step-1 setup's own output, so no flag records that setup ran. */
  isProvisioned: (descriptor: ClaudeProfileLaunchDescriptor) => boolean
  readiness: (accountId: string) => ClaudeProfileReadiness
  /** Implemented on the owning host/guest; never materializes through a Windows UNC share. */
  prepare: (descriptor: ClaudeProfileLaunchDescriptor) => Promise<ClaudeProfileSetupReport>
  trust?: (descriptor: ClaudeProfileLaunchDescriptor, workspace: string) => Promise<void>
  publish: (descriptor: ClaudeProfileLaunchDescriptor) => Promise<void>
  /** Removes the pointer so the shell refuses visibly; never throws. */
  withdraw: (target?: ClaudeAccountSelectionTarget) => void | Promise<void>
}
