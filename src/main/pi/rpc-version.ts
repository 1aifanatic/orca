import {
  hasReachedAppVersion,
  isPrereleaseAppVersion,
  parseCliVersion
} from '../../shared/app-version'
import { runProcess, type ProcessSpec } from '../../shared/child-process/run-process'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'

/** The supported RPC line emits agent_settled after retries and detached compaction. */
export function supportsPiRpcVersion(output: string): boolean {
  const version = parseCliVersion(output)
  return (
    version !== null &&
    version.startsWith('1.') &&
    !isPrereleaseAppVersion(version) &&
    hasReachedAppVersion(version, '1.0.0')
  )
}

export function resolvePiRpcCommand(env: NodeJS.ProcessEnv): string {
  const pathEnv = env.PATH ?? env.Path ?? null
  const homePath = env.HOME ?? env.USERPROFILE
  return resolveCliCommand('pi', { pathEnv, ...(homePath ? { homePath } : {}) })
}

export async function probePiRpcVersion(
  input: Pick<ProcessSpec, 'program' | 'cwd' | 'env'>
): Promise<boolean> {
  try {
    const result = await runProcess({
      ...input,
      args: ['--version'],
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      killOnOutputLimit: true
    })
    return (
      result.code === 0 &&
      !result.timedOut &&
      !result.outputTruncated &&
      supportsPiRpcVersion(result.stdout)
    )
  } catch {
    return false
  }
}
