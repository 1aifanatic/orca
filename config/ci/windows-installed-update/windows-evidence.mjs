// Process and filesystem evidence for the Windows installed-lifecycle diagnostic.
// Verdicts use the execution-boundary vocabulary: live / unverifiable / exited.
import { join, win32 } from 'node:path'

const GENERATION = /^bun-[a-f0-9]{64}(?:\.repair-[1-9][0-9]*)?$/u

export function powershellPath(env = process.env) {
  return win32.join(
    env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
}

// One CIM snapshot; @() keeps a single row an array under PowerShell 5.1.
export const PROCESS_TABLE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$rows=@(Get-CimInstance Win32_Process | ForEach-Object {',
  "  [pscustomobject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;name=[string]$_.Name;exe=[string]$_.ExecutablePath;command=[string]$_.CommandLine;created=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{''})}",
  '})',
  'ConvertTo-Json -InputObject @{rows=$rows} -Depth 3 -Compress'
].join('\n')

/** Returns null when the snapshot is incomplete; callers must treat that as unverifiable. */
export function parseProcessTable(stdout) {
  let parsed
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  const rows = parsed?.rows
  if (!Array.isArray(rows) || rows.length === 0) {
    return null
  }
  const result = []
  for (const row of rows) {
    if (!Number.isSafeInteger(row?.pid) || typeof row.name !== 'string') {
      return null
    }
    result.push({
      pid: row.pid,
      ppid: Number.isSafeInteger(row.ppid) ? row.ppid : null,
      name: row.name,
      exe: typeof row.exe === 'string' && row.exe ? row.exe : null,
      command: typeof row.command === 'string' && row.command ? row.command : null,
      created: typeof row.created === 'string' && row.created ? row.created : null
    })
  }
  return result
}

/** Identity is pid plus creation time; a reused pid is a different process. */
export function processIdentity(table, pid) {
  if (!table) {
    return null
  }
  const row = table.find((candidate) => candidate.pid === pid)
  return row?.created ? { pid, created: row.created, exe: row.exe, command: row.command } : null
}

export function processVerdict(table, identity) {
  if (!table || !identity?.created) {
    return 'unverifiable'
  }
  const row = table.find((candidate) => candidate.pid === identity.pid)
  if (!row) {
    return 'exited'
  }
  if (!row.created) {
    return 'unverifiable'
  }
  return row.created === identity.created ? 'live' : 'exited'
}

function normalized(path) {
  return path.replaceAll('/', '\\').replace(/\\+$/u, '').toLowerCase()
}

export function isUnder(path, root) {
  return typeof path === 'string' && normalized(path).startsWith(`${normalized(root)}\\`)
}

/** Generation directory that owns a runtime image, or null when outside the managed namespace. */
export function generationOfImage(exe, managedRoot) {
  if (!isUnder(exe, managedRoot)) {
    return null
  }
  const [directory, file, ...rest] = normalized(exe)
    .slice(normalized(managedRoot).length + 1)
    .split('\\')
  return rest.length === 0 && file === 'bun-runtime.exe' && GENERATION.test(directory)
    ? directory
    : null
}

export function isGenerationName(name) {
  return GENERATION.test(name)
}

/** Every live process whose image is inside one of the given roots. */
export function processesUnder(table, roots) {
  return table.filter((row) => row.exe && roots.some((root) => isUnder(row.exe, root)))
}

export function managedRootFor(localAppData) {
  return join(localAppData, 'Orca', 'terminal-daemon-host', 'managed-v1')
}
