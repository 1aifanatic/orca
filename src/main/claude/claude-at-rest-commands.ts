import { join } from 'node:path'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'
import { structuredSlashCommands } from '../../shared/structured-agent-session-composer'
import { discoverSkills } from '../skills/discovery'
import { scanClaudeCommandFolders } from './claude-command-folder-scan'
import { supportsClaudeStructuredLocation } from './claude-structured-location-support'

/** How long one scan answers for a workspace and account before the next read scans again. */
export const CLAUDE_AT_REST_COMMANDS_TTL_MS = 10_000
/** A scan still unanswered this long is given up on, so a hung folder can't freeze the menu. */
const SCAN_ABANDONED_MS = 30_000

export type ClaudeAtRestCommandsDeps = {
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  now?: () => number
  discover?: typeof discoverSkills
}

type Entry = {
  commands?: AgentSessionSlashCommand[]
  scannedAt: number
  /** When the scan in flight began; only its answer is kept. */
  scanStartedAt: number | null
}

/**
 * The `/` surface of a Claude chat whose Claude is not running, read from the folders Claude reads
 * its own from on the host that runs it: the account's and the workspace's command folders and
 * skills, beside the commands the chat's menu always offers. Nothing until the first scan lands;
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
      entry = { scannedAt: Number.NEGATIVE_INFINITY, scanStartedAt: null }
      this.entries.set(key, entry)
    }
    const now = this.now()
    const idle =
      entry.scanStartedAt === null
        ? now - entry.scannedAt >= CLAUDE_AT_REST_COMMANDS_TTL_MS
        : now - entry.scanStartedAt >= SCAN_ABANDONED_MS
    if (idle) {
      this.scanInto(entry, record)
    }
    return entry.commands
  }

  onChange = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private scanInto(entry: Entry, record: AgentSessionRecord): void {
    const startedAt = this.now()
    entry.scanStartedAt = startedAt
    const current = () => entry.scanStartedAt === startedAt
    void this.scan(record)
      .then(
        (commands) => {
          if (!current() || JSON.stringify(commands) === JSON.stringify(entry.commands)) {
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
        if (current()) {
          entry.scanStartedAt = null
          entry.scannedAt = this.now()
        }
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
    // What the menu offers a Claude chat at rest without a list, so reading one loses none of it.
    const builtIn = structuredSlashCommands(['clear', 'compact'], 'claude').map(
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
