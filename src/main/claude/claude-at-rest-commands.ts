import { join } from 'node:path'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'
import { getTextDrivenNativeChatCommands } from '../../shared/native-chat-agent-profiles'
import { discoverSkills } from '../skills/discovery'
import { scanClaudeCommandFolders } from './claude-command-folder-scan'
import { supportsClaudeStructuredLocation } from './claude-structured-location-support'

/** How long one scan answers for a workspace and account before the next read scans again. */
export const CLAUDE_AT_REST_COMMANDS_TTL_MS = 10_000

export type ClaudeAtRestCommandsDeps = {
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  now?: () => number
  discover?: typeof discoverSkills
}

type Entry = {
  commands?: AgentSessionSlashCommand[]
  scannedAt: number
  scanning: boolean
}

/**
 * The `/` surface of a Claude chat whose Claude is not running, read from the folders Claude reads
 * its own from on the host that runs it: the account's and the workspace's command folders and
 * skills, beside the built-in commands Orca knows Claude has. Nothing until the first scan lands;
 * `onChange` fires when a scan finds something different.
 */
export class ClaudeAtRestCommandCatalog {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: ClaudeAtRestCommandsDeps) {}

  read = (record: AgentSessionRecord): AgentSessionSlashCommand[] | undefined => {
    // Another host's folders are only readable there, so this host never answers for them.
    if (record.provider !== 'claude' || !supportsClaudeStructuredLocation(record.location)) {
      return undefined
    }
    const key = JSON.stringify([record.location.workspaceId, record.accountHome.path])
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { scannedAt: Number.NEGATIVE_INFINITY, scanning: false }
      this.entries.set(key, entry)
    }
    if (!entry.scanning && this.now() - entry.scannedAt >= CLAUDE_AT_REST_COMMANDS_TTL_MS) {
      this.scanInto(entry, record)
    }
    return entry.commands
  }

  onChange = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private scanInto(entry: Entry, record: AgentSessionRecord): void {
    entry.scanning = true
    void this.scan(record)
      .then(
        (commands) => {
          if (JSON.stringify(commands) === JSON.stringify(entry.commands)) {
            return
          }
          entry.commands = commands
          for (const listener of this.listeners) {
            listener()
          }
        },
        (error: unknown) => console.warn('[claude] reading the at-rest `/` commands failed:', error)
      )
      .finally(() => {
        entry.scanning = false
        entry.scannedAt = this.now()
      })
  }

  private async scan(record: AgentSessionRecord): Promise<AgentSessionSlashCommand[]> {
    const cwd = await this.deps.resolveWorkspacePath(record.location.workspaceId)
    const account = record.accountHome.path
    const [custom, discovered] = await Promise.all([
      scanClaudeCommandFolders([join(cwd, '.claude', 'commands'), join(account, 'commands')]),
      (this.deps.discover ?? discoverSkills)({
        repos: [],
        cwd,
        providerRootOverrides: { claude: join(account, 'skills') }
      })
    ])
    const builtIn = getTextDrivenNativeChatCommands('claude').map(
      (command): AgentSessionSlashCommand => ({
        name: command.name,
        kind: 'command',
        ...(command.description ? { description: command.description } : {})
      })
    )
    const names = new Set(builtIn.map((command) => command.name))
    const skills = discovered.skills
      .filter((skill) => skill.providers.includes('claude'))
      .map((skill): AgentSessionSlashCommand => ({
        name: skill.name,
        kind: 'skill',
        ...(skill.description ? { description: skill.description } : {})
      }))
    return [...builtIn, ...custom.filter((command) => !names.has(command.name)), ...skills]
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
