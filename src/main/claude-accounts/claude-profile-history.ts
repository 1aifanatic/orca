import {
  appendFileSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { assertDistinctClaudeProfile, isMissingProfileFile } from './claude-profile-paths'

export const CLAUDE_PROFILE_HISTORY_DIRS = [
  'projects',
  'sessions',
  'session-env',
  'file-history',
  'shell-snapshots',
  'todos',
  'paste-cache',
  'tasks',
  'plans',
  'transcripts'
] as const
const MERGE_SUFFIX = '.orca-profile-merge'

function entry(file: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(file)
  } catch (error) {
    if (!isMissingProfileFile(error)) {
      throw error
    }
    return undefined
  }
}

function moveHistoryTree(source: string, destination: string): void {
  for (const item of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, item.name)
    const to = join(destination, item.name)
    const existing = entry(to)
    if (!existing) {
      renameSync(from, to)
    } else if (item.isDirectory() && existing.isDirectory()) {
      moveHistoryTree(from, to)
    }
  }
  if (readdirSync(source).length === 0) {
    rmdirSync(source)
  }
}

function mergeDirectory(
  profile: string,
  home: string,
  name: string,
  platform: NodeJS.Platform
): void {
  const source = join(profile, name)
  const destination = join(home, name)
  const pending = `${source}${MERGE_SUFFIX}`
  mkdirSync(destination, { recursive: true })
  const sameDevice = (file: string): boolean => statSync(file).dev === statSync(destination).dev
  if (entry(pending)?.isDirectory()) {
    if (!sameDevice(pending)) {
      if (!entry(source)) {
        renameSync(pending, source)
      }
      throw new Error('History merge crosses filesystems; keeping private history')
    }
    moveHistoryTree(pending, destination)
  }
  const current = entry(source)
  if (current?.isSymbolicLink()) {
    if (realpathSync(source) !== realpathSync(destination)) {
      throw new Error('History link is user-owned')
    }
    return
  }
  if (current && !current.isDirectory()) {
    throw new Error('History path is user-owned')
  }
  if (current) {
    if (!sameDevice(source)) {
      throw new Error('History merge crosses filesystems; keeping private history')
    }
    if (entry(pending)) {
      throw new Error('History merge has retained conflicts')
    }
    renameSync(source, pending)
  }
  try {
    symlinkSync(destination, source, platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (current) {
      if (!entry(source)) {
        renameSync(pending, source)
      } else if (entry(source)?.isDirectory()) {
        moveHistoryTree(pending, source)
      }
    }
    throw error
  }
  if (current) {
    moveHistoryTree(pending, destination)
  }
}

function appendHistory(destination: string, bytes: Buffer): void {
  if (bytes.length === 0) {
    return
  }
  const size = statSync(destination).size
  let separator = false
  if (size > 0) {
    const fd = openSync(destination, 'r')
    try {
      const tail = Buffer.alloc(1)
      readSync(fd, tail, 0, 1, size - 1)
      separator = tail[0] !== 10
    } finally {
      closeSync(fd)
    }
  }
  appendFileSync(destination, separator ? Buffer.concat([Buffer.from('\n'), bytes]) : bytes)
}

function drainHistory(pending: string, destination: string): void {
  const content = readFileSync(pending)
  let offset = 0
  try {
    const stored = Number(readFileSync(`${pending}.offset`, 'utf8'))
    if (Number.isSafeInteger(stored) && stored >= 0 && stored <= content.length) {
      offset = stored
    }
  } catch (error) {
    if (!isMissingProfileFile(error)) {
      throw error
    }
  }
  appendHistory(destination, content.subarray(offset))
  // Advance only after append; a crash can duplicate records, never discard unattempted bytes.
  writeFileSync(`${pending}.offset`, `${content.length}\n`, { mode: 0o600 })
}

function mergePromptHistory(profile: string, home: string, platform: NodeJS.Platform): void {
  const source = join(profile, 'history.jsonl')
  const destination = join(home, 'history.jsonl')
  const prefix = `history.jsonl${MERGE_SUFFIX}`
  if (!entry(destination)) {
    writeFileSync(destination, '', { flag: 'wx', mode: 0o600 })
  }
  for (const item of readdirSync(profile, { withFileTypes: true })) {
    if (
      item.isFile() &&
      (item.name === prefix ||
        (item.name.startsWith(`${prefix}-`) && /^\d+$/.test(item.name.slice(prefix.length + 1))))
    ) {
      drainHistory(join(profile, item.name), destination)
    }
  }
  const current = entry(source)
  if (current?.isSymbolicLink()) {
    if (realpathSync(source) !== realpathSync(destination)) {
      throw new Error('Prompt history link is user-owned')
    }
    return
  }
  if (current && !current.isFile()) {
    throw new Error('Prompt history path is user-owned')
  }
  if (platform === 'win32' && current) {
    const target = statSync(destination)
    if (current.dev === target.dev && current.ino === target.ino) {
      return
    }
  }
  if (platform === 'win32' && statSync(profile).dev !== statSync(home).dev) {
    throw new Error('Prompt history hardlink crosses volumes; keeping private history')
  }
  let pending = join(profile, prefix)
  if (current) {
    let generation = 0
    while (entry(pending)) {
      pending = join(profile, `${prefix}-${++generation}`)
    }
    renameSync(source, pending)
  }
  try {
    if (platform === 'win32') {
      linkSync(destination, source)
    } else {
      symlinkSync(destination, source)
    }
  } catch (error) {
    if (current && !entry(source)) {
      renameSync(pending, source)
    }
    throw error
  }
  if (current) {
    drainHistory(pending, destination)
  }
}

export function shareClaudeProfileHistory(args: {
  profileHome: string
  defaultHome: string
  platform?: NodeJS.Platform
}): Record<string, string> {
  assertDistinctClaudeProfile(args.profileHome, args.defaultHome)
  mkdirSync(args.profileHome, { recursive: true, mode: 0o700 })
  mkdirSync(args.defaultHome, { recursive: true, mode: 0o700 })
  const platform = args.platform ?? process.platform
  const warnings: Record<string, string> = {}
  for (const name of [...CLAUDE_PROFILE_HISTORY_DIRS, 'history.jsonl']) {
    try {
      if (name === 'history.jsonl') {
        mergePromptHistory(args.profileHome, args.defaultHome, platform)
      } else {
        mergeDirectory(args.profileHome, args.defaultHome, name, platform)
      }
    } catch (error) {
      warnings[name] = error instanceof Error ? error.message : String(error)
    }
  }
  return warnings
}
