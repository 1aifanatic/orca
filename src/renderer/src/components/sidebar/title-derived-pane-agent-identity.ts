import { titleShowsNoAgent } from '../../../../shared/agent-detection'
import type { AgentType } from '../../../../shared/agent-status-types'
import { resolveCompatibleAgentTypeForOwner } from '../../../../shared/agent-title-owner'
import {
  resolvePaneAgentIdentity,
  type PaneAgentEvidence
} from '../../../../shared/pane-agent-identity-resolver'
import { isClaudeIdentityFrameTitle } from '../../../../shared/terminal-title-agent-type'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

const TITLE_AGENT_LABEL_TO_TYPE: Record<string, AgentType> = {
  'Claude Code': 'claude',
  OpenClaude: 'openclaude',
  Codex: 'codex',
  'Gemini CLI': 'gemini',
  'GitHub Copilot': 'copilot',
  Grok: 'grok',
  Devin: 'devin',
  Antigravity: 'antigravity',
  OpenCode: 'opencode',
  Aider: 'aider',
  Cursor: 'cursor',
  Droid: 'droid',
  Hermes: 'hermes',
  Pi: 'pi',
  OMP: 'omp'
}

const CLAUDE_AGENT_TOKEN_RE = /(?<![\w./\\-])claude(?![\w./\\-])/i

export function resolveTitleDerivedAgentType(
  title: string,
  label: string,
  ownerAgentType?: AgentType | null
): AgentType | null {
  const agentType = TITLE_AGENT_LABEL_TO_TYPE[label] ?? 'unknown'
  if (agentType !== 'claude') {
    return agentType
  }
  // Why: Claude's task-title spinner heuristic has no provider identity. In
  // split panes it can match arbitrary terminal spinners, so sidebar rows only
  // accept Claude when the title itself names Claude.
  if (!CLAUDE_AGENT_TOKEN_RE.test(title)) {
    return null
  }
  // Why: a "claude" word inside another agent's task text is a mention, not identity.
  // Only a title that PRESENTS Claude may take a pane away from its known owner (#8940).
  const owner = ownerAgentType && ownerAgentType !== 'unknown' ? ownerAgentType : null
  if (owner && owner !== 'claude' && !isClaudeIdentityFrameTitle(title)) {
    return null
  }
  return agentType
}

/** The foreground-process facts a hook-less row reads; the rest of the entry is routing state. */
export type TitleDerivedPaneForeground = Pick<PaneForegroundAgentEntry, 'agent' | 'shellForeground'>

/**
 * Which agent a hook-less pane runs, ranked by the canonical resolver: the foreground process,
 * then the agent Orca launched, then the title. Null means the pane shows no agent row.
 *
 * Only facts that die with the agent may keep a row whose title names no agent (Codex retitles
 * itself to the project name, #23767): the process read clears on exit, and launch ownership is
 * dropped once the process tracker proves the shell is back. A shell or default title retires
 * both, matching the tab's launched-agent exit rule.
 */
export function resolveTitleDerivedPaneAgent(args: {
  title: string
  defaultTitle?: string
  titleAgentType: AgentType | null
  launchAgentType: AgentType | null
  foreground: TitleDerivedPaneForeground | undefined
}): AgentType | null {
  const evidence: PaneAgentEvidence<AgentType>[] = []
  // Why: a shell/default title retires process and launch facts, never an agent the title names.
  const titleShowsExit = titleShowsNoAgent(args.title, args.defaultTitle)
  const processAgent = titleShowsExit ? null : args.foreground?.agent
  if (processAgent) {
    // Why: OMP's nested pi process must not take an OMP-launched pane from its owner.
    const agent =
      resolveCompatibleAgentTypeForOwner(processAgent, args.launchAgentType) ?? processAgent
    evidence.push({ source: 'process', agent })
  }
  if (args.launchAgentType && !titleShowsExit && args.foreground?.shellForeground !== true) {
    evidence.push({ source: 'launch', agent: args.launchAgentType })
  }
  if (args.titleAgentType) {
    evidence.push({ source: 'title', agent: args.titleAgentType })
  }
  return resolvePaneAgentIdentity<AgentType>({ evidence }).agent
}
