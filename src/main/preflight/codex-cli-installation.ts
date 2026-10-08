import { stat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import {
  codexCliInstallation,
  type CodexCliInstallation
} from '../../shared/codex-cli-installation'
import { resolveSpawn, type ProcessSpec } from '../../shared/child-process/run-process'
import { readAgentCliVersion } from '../agent-cli-version-probe'
import { listLocalCommandPaths } from '../ipc/command-path-resolver'
import { CodexCliInstallationCache } from './codex-cli-installation-cache'

const cache = new CodexCliInstallationCache()

async function stamp(file: string): Promise<string> {
  try {
    const value = await stat(file)
    return `${file}:${value.ino}:${value.mtimeMs}:${value.ctimeMs}:${value.size}`
  } catch {
    return `${file}:unverifiable`
  }
}

export function invalidateCodexCliInstallation(): void {
  cache.clear()
}

export async function codexCliPackagePaths(
  input: Pick<ProcessSpec, 'program' | 'env'>
): Promise<string[]> {
  const resolved = resolveSpawn(input, process.platform)
  const target = await realpath(input.program).catch(() => input.program)
  const launchers = [target, ...resolved.args.filter(isAbsolute)]
  return [...new Set(launchers.map((file) => join(dirname(dirname(file)), 'package.json')))]
}

async function binaryFingerprint(input: Pick<ProcessSpec, 'program' | 'env'>): Promise<string> {
  const resolved = resolveSpawn(input, process.platform)
  const target = await realpath(input.program).catch(() => input.program)
  const files = new Set([
    input.program,
    target,
    resolved.file,
    ...resolved.args.filter(isAbsolute),
    // npm can keep its launcher unchanged while replacing the package underneath it.
    ...(await codexCliPackagePaths(input))
  ])
  return JSON.stringify(await Promise.all([...files].map(stamp)))
}

export async function readCodexCliInstallation(
  input: Pick<ProcessSpec, 'program' | 'cwd' | 'env'>
): Promise<CodexCliInstallation> {
  const program = isAbsolute(input.program)
    ? input.program
    : (
        await listLocalCommandPaths(input.program, {
          env: input.env,
          cwd: input.cwd,
          maxResults: 1
        })
      )[0]
  if (!program) {
    return codexCliInstallation(false, null)
  }
  try {
    await stat(program)
  } catch (error) {
    const missing =
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    return codexCliInstallation(!missing, null)
  }
  const launch = { ...input, program }
  const fingerprint = await binaryFingerprint(launch)
  return cache.read(`native:${program}`, fingerprint, async () => {
    const result = await readAgentCliVersion(launch)
    return codexCliInstallation(true, result.version)
  })
}
