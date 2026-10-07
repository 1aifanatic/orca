import {
  hasReachedAppVersion,
  isPrereleaseAppVersion,
  parseCliVersion
} from '../shared/app-version'
import { runProcess, type ProcessSpec } from '../shared/child-process/run-process'

/** Runs `<program> --version` on this host and asks `supports` about the version it prints. False
 *  when it cannot tell: a failed spawn, a non-zero exit, a timeout, or output with no version. */
export async function probeAgentCliVersion(
  input: Pick<ProcessSpec, 'program' | 'cwd' | 'env'>,
  supports: (version: string) => boolean
): Promise<boolean> {
  try {
    const result = await runProcess({
      ...input,
      args: ['--version'],
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      killOnOutputLimit: true
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      return false
    }
    const version = parseCliVersion(result.stdout)
    return version !== null && supports(version)
  } catch {
    return false
  }
}

/** A stable release on `major`'s line, at or after `floor`. */
export function isStableCliVersionOnLine(
  version: string,
  line: { major: number; floor: string }
): boolean {
  return (
    version.startsWith(`${line.major}.`) &&
    !isPrereleaseAppVersion(version) &&
    hasReachedAppVersion(version, line.floor)
  )
}
