// How Orca starts each ACP agent, as data: adding an agent is one more row (plus a dialect when it
// speaks protocol extensions). Nothing outside `acp-dialects/` branches on an agent's name.

import { join } from 'node:path'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'

export type AcpLaunchSpec = {
  /** The Orca agent id (a `TuiAgent`), which names the agent's records and its catalog label. */
  agent: string
  command: string
  /** Built per launch: `fullAccess` is the Agent Permissions setting's bypass posture. */
  args(input: { fullAccess: boolean }): string[]
  /** Overlaid on the child's environment. */
  env: Readonly<Record<string, string>>
  dialect: AcpDialect
  /** The agent's own sign-in command, for a person to run when it reports auth required. */
  loginCommand: readonly string[]
  /** Variable naming the agent's config directory, pinned as each record's account home. */
  accountHomeVariable: string
  /** The config directory the agent uses when the variable is unset, under the user's home. */
  defaultAccountHome(homePath: string): string
  /** Where the agent installs its own binary, searched after PATH. */
  installDirectories(accountHomePath: string): string[]
}

const GROK_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'grok',
  command: 'grok',
  // Orca owns this child's lifetime: no self-update mid-chat and no shared leader process it
  // cannot stop. `--always-approve` only for full access, as the user's setting chooses.
  args: ({ fullAccess }) => [
    '--no-auto-update',
    'agent',
    '--no-leader',
    ...(fullAccess ? ['--always-approve'] : []),
    'stdio'
  ],
  env: { GROK_DISABLE_AUTOUPDATER: '1' },
  dialect: GROK_ACP_DIALECT,
  loginCommand: ['grok', 'login'],
  accountHomeVariable: 'GROK_HOME',
  defaultAccountHome: (homePath) => join(homePath, '.grok'),
  installDirectories: (accountHomePath) => [join(accountHomePath, 'bin')]
}

export const ACP_LAUNCH_SPECS: readonly AcpLaunchSpec[] = [GROK_LAUNCH_SPEC]

export function acpLaunchSpecFor(agent: string): AcpLaunchSpec | null {
  return ACP_LAUNCH_SPECS.find((spec) => spec.agent === agent) ?? null
}

/**
 * A pane's identity in the inherited environment would let the agent's own Orca status hooks
 * report for this session too; the structured session is its one status producer.
 */
export const ACP_CHILD_ENV_TO_DELETE: readonly string[] = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_AGENT_PANE',
  'ORCA_AGENT_LAUNCH',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENDPOINT',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION'
]
