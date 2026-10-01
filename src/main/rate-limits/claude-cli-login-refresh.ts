import { buildConfiguredProxyEnv, type NetworkProxySettings } from '../../shared/network-proxy'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { whenClaudeAuthSwitchSettles } from '../claude-accounts/live-pty-gate'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { withoutInheritedClaudeConfigDir } from '../claude/claude-config-dir-pin'
import {
  openClaudeStreamJsonConnection,
  type ClaudeStreamJsonConnection,
  type ClaudeStreamJsonLaunch
} from '../claude/claude-stream-json-connection'
import { resolveClaudeCommand } from '../codex-cli/command'
import { resolveHiddenRateLimitPtyCwd } from './hidden-rate-limit-pty-cwd'

const USAGE_REQUEST_TIMEOUT_MS = 20_000

export type ClaudeCliLoginRefreshOutcome =
  | { kind: 'answered' }
  /** The installed CLI has no `get_usage`; retrying the same binary cannot change that. */
  | { kind: 'unsupported'; message: string }
  | { kind: 'failed'; message: string }

type ConnectClaude = typeof openClaudeStreamJsonConnection

function isUnsupportedSubtype(message: string): boolean {
  return /unsupported control request|no control request/i.test(message)
}

/**
 * Asks the account's own Claude CLI for plan usage so it refreshes its login under its own
 * refresh lock and saves it to its own store. The answer itself is discarded: the CLI may serve
 * a cached reading and reports transport failures as an empty one, so the caller re-reads the
 * stored credentials and asks the usage endpoint itself.
 */
export async function refreshClaudeLoginViaCli(input: {
  authPreparation: ClaudeRuntimeAuthPreparation
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
  connect?: ConnectClaude
  resolveCommand?: () => string
}): Promise<ClaudeCliLoginRefreshOutcome> {
  if (input.signal?.aborted) {
    return { kind: 'failed', message: 'aborted' }
  }
  // A switch re-materializes the runtime credentials this child would refresh.
  if (!(await whenClaudeAuthSwitchSettles())) {
    return { kind: 'failed', message: 'a Claude account switch is in progress' }
  }
  const command = (input.resolveCommand ?? resolveClaudeCommand)()
  const launch: ClaudeStreamJsonLaunch = {
    pathToClaudeCodeExecutable: command,
    // No user message is ever sent, so nothing reaches the model; these keep the session-less
    // child from running hooks, MCP servers or project settings, or saving a transcript.
    options: {
      settingSources: ['user'],
      persistSession: false,
      strictMcpConfig: true,
      mcpServers: {},
      settings: { disableAllHooks: true }
    },
    // Untrusted folders are trusted in headless mode, so the child gets an empty Orca-owned one.
    cwd: resolveHiddenRateLimitPtyCwd(),
    env: withCliRuntimeOnPath(command, {
      ...applyClaudeEnvPatch(
        withoutInheritedClaudeConfigDir(process.env),
        input.authPreparation.envPatch,
        { stripAuthEnv: input.authPreparation.stripAuthEnv }
      ),
      // The CLI spawned directly would otherwise reach Anthropic outside the user's proxy.
      ...buildConfiguredProxyEnv(input.networkProxySettings),
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false'
    })
  }

  const fault: { first: Error | null } = { first: null }
  let connection: ClaudeStreamJsonConnection | null = null
  const closeOnAbort = (): void => {
    void connection?.close()
  }
  input.signal?.addEventListener('abort', closeOnAbort, { once: true })
  try {
    connection = await (input.connect ?? openClaudeStreamJsonConnection)(launch, {
      onFault: (error) => {
        fault.first ??= error
      }
    })
    if (input.signal?.aborted) {
      return { kind: 'failed', message: 'aborted' }
    }
    await connection.getUsage({ timeoutMs: USAGE_REQUEST_TIMEOUT_MS })
    return { kind: 'answered' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isUnsupportedSubtype(message)) {
      return { kind: 'unsupported', message }
    }
    // An exit before the reply (e.g. unaccepted terms) closes the query; the stderr tail is the reason.
    return { kind: 'failed', message: fault.first?.message ?? message }
  } finally {
    input.signal?.removeEventListener('abort', closeOnAbort)
    await connection?.close()
  }
}
