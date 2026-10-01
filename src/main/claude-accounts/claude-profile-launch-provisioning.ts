import type {
  ClaudeProfileHostAccess,
  ClaudeProfileLaunchDescriptor,
  ClaudeProfileRoutingOwner
} from './claude-profile-routing-owner'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'

/** Ownership refusal stops the caller; a worker fault on an already prepared profile only warns. */
export async function provisionClaudeLaunchProfile(
  owner: Pick<ClaudeProfileRoutingOwner, 'isProvisioned' | 'prepare'>,
  descriptor: ClaudeProfileLaunchDescriptor,
  access: ClaudeProfileHostAccess
): Promise<void> {
  const provisioned = owner.isProvisioned(descriptor)
  let report: ClaudeProfileSetupReport
  try {
    report = await owner.prepare(descriptor, access)
  } catch (error) {
    if (!provisioned || descriptor.target.runtime === 'wsl') {
      throw error
    }
    console.warn('[claude-profile] Setup failed; launching the already prepared profile:', error)
    return
  }
  if (report.outcome === 'refused') {
    throw new Error('Selected Claude profile could not be prepared')
  }
}
