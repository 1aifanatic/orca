// Fixtures and DOM lookups shared by the resume dialog's per-machine test files.

import type { RestartOfferOrigin } from '../../../shared/restart-offer-origin'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'

/** One chat per workspace; each host says whose a chat is for this desktop. */
export function machineRowFixture(sessionId: string, origin: RestartOfferOrigin): ResumeCandidate {
  return {
    sessionId,
    workspaceId: `workspace-${sessionId}`,
    agent: 'codex',
    trigger: 'update',
    latestPrompt: `Prompt ${sessionId}`,
    recordedAt: 1_800_000_000_000,
    executionHostId: 'local',
    workspaceKind: 'git-worktree',
    origin
  }
}

export function machineToggle(name: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[aria-label="Resume every chat on ${name}"]`)
  if (!found) {
    throw new Error(`Missing machine checkbox: ${name}`)
  }
  return found
}

/** The machine row's expand control, which carries its name, cause, age and count. */
export function machineRow(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find(
    (entry) => entry.textContent?.startsWith(name)
  )
  if (!found) {
    throw new Error(`Missing machine row: ${name}`)
  }
  return found
}
