import type { AiVaultSession } from '../../../../shared/ai-vault-types'

/**
 * Where "Resume in New CLI" opens its copy of a conversation native chat owns, or null when the row
 * does not offer it. A row no chat owns already resumes in the CLI through plain Resume, and only
 * Claude and Codex can fork.
 */
export function aiVaultSessionCliForkWorktreeId(
  session: Pick<AiVaultSession, 'agent' | 'structuredSession'>,
  resume: { worktreeId: string | null | undefined; disabled: boolean }
): string | null {
  if (!session.structuredSession || resume.disabled || !resume.worktreeId) {
    return null
  }
  return session.agent === 'claude' || session.agent === 'codex' ? resume.worktreeId : null
}
