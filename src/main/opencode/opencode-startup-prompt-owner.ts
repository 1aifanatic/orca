import { agentHookServer } from '../agent-hooks/server'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { IPtyProvider, PtySpawnResult } from '../providers/types'
import { ptyIncarnationById, ptyOwnership } from '../ipc/pty/provider/ownership-state'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import {
  OPENCODE_STARTUP_PROMPT_NONCE_ENV,
  OPENCODE_STARTUP_PROMPT_SHA256_ENV
} from '../../shared/opencode-startup-prompt'
import { OpenCodeStartupPromptClaims } from './opencode-startup-prompt-claims'

const claims = new OpenCodeStartupPromptClaims()

export async function commitPtyWithOpenCodePromptIntent<Result extends PtySpawnResult>(
  context: {
    env?: Record<string, string>
    spawnEnv?: Record<string, string>
    deps: { runtime?: OrcaRuntimeService }
    result: PtySpawnResult
    provider: IPtyProvider
    args: { connectionId?: string | null }
  },
  commit: () => Promise<Result>
): Promise<Result> {
  const options = {
    env: context.spawnEnv ?? context.env,
    runtime: context.deps.runtime,
    result: context.result,
    provider: context.provider,
    connectionId: context.args.connectionId
  }
  const facts = options.runtime?.terminalRunFacts
  facts?.reserveSpawnCommit(options.result)
  try {
    const result = await commit()
    bindOpenCodeStartupPromptOwner({ ...options, result })
    return result
  } finally {
    facts?.discardSpawnCommit(options.result)
  }
}

export function bindOpenCodeStartupPromptOwner(options: {
  env: Record<string, string> | undefined
  result: PtySpawnResult
  runtime: OrcaRuntimeService | undefined
  provider: IPtyProvider
  connectionId?: string | null
}): void {
  const { env, result, runtime, provider } = options
  const nonce = env?.[OPENCODE_STARTUP_PROMPT_NONCE_ENV]
  const digest = env?.[OPENCODE_STARTUP_PROMPT_SHA256_ENV]
  const launchToken = env?.ORCA_AGENT_LAUNCH_TOKEN
  const incarnation = result.incarnationId
  if (
    options.connectionId ||
    !runtime ||
    result.isReattach ||
    result.agentSessionEnsure?.disposition === 'adopted' ||
    !isPtyIncarnationId(incarnation) ||
    !nonce ||
    !digest ||
    !launchToken
  ) {
    return
  }
  agentHookServer.setStartupPromptClaimListener(
    (body) => claims.claim(body),
    () => claims.clear()
  )
  let unsubscribe = () => {}
  if (
    claims.register(
      nonce,
      digest,
      () => {
        if (
          ptyOwnership.get(result.id) !== null ||
          ptyIncarnationById.get(result.id) !== incarnation ||
          provider.hasPty?.(result.id) !== true ||
          runtime.isPtyStopRequested(result.id)
        ) {
          return null
        }
        return runtime.readOpenCodeStartupPromptOwner(result.id, incarnation, launchToken)
      },
      () => unsubscribe()
    )
  ) {
    unsubscribe = runtime.subscribeToPtyExit(result.id, () => claims.cancel(nonce))
  }
}
