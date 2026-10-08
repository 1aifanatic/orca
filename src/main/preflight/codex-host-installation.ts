import { z } from 'zod'
import {
  codexCliInstallation,
  type CodexCliInstallation
} from '../../shared/codex-cli-installation'
import { resolveCodexCommand } from '../../shared/node-cli-command-resolution'
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'
import { execCommandInWslOrThrow, shellQuote } from '../ipc/preflight-command-exec'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight-runtime-target'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'
import { readCodexCliInstallation } from './codex-cli-installation'
import { CodexCliInstallationCache } from './codex-cli-installation-cache'

const wslCache = new CodexCliInstallationCache()
const PATH_PREFIX = '__ORCA_CODEX_PATH__'
const STAMP_PREFIX = '__ORCA_CODEX_STAMP__'
const MISSING = '__ORCA_CODEX_MISSING__'

async function readWslCodexInstallation(
  target: NonNullable<ReturnType<typeof getPreflightWslTarget>>
): Promise<CodexCliInstallation> {
  const script = [
    buildPosixCommandPathLookupScript(
      { kind: 'literal', value: 'codex' },
      { skipWindowsMountDirs: true }
    ),
    'if [ -n "$resolved" ]; then',
    `printf '${PATH_PREFIX}%s\\n' "$resolved"`,
    `printf '${STAMP_PREFIX}'`,
    'stat -L -c "%i:%y:%z:%s" -- "$resolved"',
    'else',
    `printf '${MISSING}\\n'`,
    'fi'
  ].join('\n')
  try {
    const { stdout } = await execCommandInWslOrThrow(target, script)
    const lines = stdout.split(/\r?\n/)
    if (lines.includes(MISSING)) {
      return codexCliInstallation(false, null)
    }
    const binary = lines.find((line) => line.startsWith(PATH_PREFIX))?.slice(PATH_PREFIX.length)
    const stamp = lines.find((line) => line.startsWith(STAMP_PREFIX))
    if (!binary || !stamp) {
      return codexCliInstallation(true, null)
    }
    return await wslCache.read(
      `wsl:${target.distro ?? ''}:${binary}`,
      `${binary}:${stamp}`,
      async () => {
        try {
          const version = await execCommandInWslOrThrow(target, `${shellQuote(binary)} --version`)
          return codexCliInstallation(true, version.stdout)
        } catch {
          return codexCliInstallation(true, null)
        }
      }
    )
  } catch {
    console.warn('[codex-cli-version] Could not verify WSL host installation')
    return codexCliInstallation(true, null)
  }
}

export async function detectCodexInstallationOnHost(
  options: { connectionId?: string | null; context?: PreflightRuntimeContext } = {}
): Promise<CodexCliInstallation> {
  if (options.connectionId) {
    const mux = getActiveMultiplexer(options.connectionId)
    if (!mux || mux.isDisposed()) {
      return codexCliInstallation(true, null)
    }
    try {
      const result = z
        .object({
          agents: z.array(z.string()),
          versions: z.record(z.string(), z.string()).optional()
        })
        .parse(
          await mux.request('preflight.detectAgents', {
            commands: [{ id: 'codex', cmd: 'codex', reportVersion: true }]
          })
        )
      return codexCliInstallation(result.agents.includes('codex'), result.versions?.codex ?? null)
    } catch {
      console.warn('[codex-cli-version] Could not verify SSH host installation')
      return codexCliInstallation(true, null)
    }
  }
  const target = getPreflightWslTarget(options.context)
  if (target) {
    return readWslCodexInstallation(target)
  }
  return readCodexCliInstallation({ program: resolveCodexCommand() })
}
