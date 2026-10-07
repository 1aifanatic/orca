export const AGENT_LAUNCH_TARGET_FORBIDDEN_CODE = 'agent_launch_target_forbidden' as const

// The caller may not call the create method this target stands for; refused before admission.
export class AgentLaunchTargetForbiddenError extends Error {
  constructor() {
    super(AGENT_LAUNCH_TARGET_FORBIDDEN_CODE)
    this.name = 'AgentLaunchTargetForbiddenError'
  }
}
