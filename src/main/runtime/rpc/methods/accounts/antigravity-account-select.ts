import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { AntigravityAccountSelectParams } from '../../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import type { AntigravityAccountSelectResult } from '../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import { getAntigravityAccountService } from '../../../../antigravity/native-account-host'
import { antigravitySignInHoldsNativeLogin } from '../../../../antigravity/antigravity-chat-sign-in'
import { AGY_HOST_SELECTION } from '../../../../antigravity/agy-account-selection'
import { withAntigravityChatBackend } from './antigravity-chat-backend'
import { forgetAgyLogin } from './agy-login-change'
import { answerAntigravityTerminalsAsk } from './antigravity-terminals-ask-answer'

/** Selects a saved Antigravity account: agy's login now, chats at their next send, and the host's
 *  agy terminals per the running-sessions setting. */
export async function selectAntigravityAccount(
  {
    target,
    accountId,
    movesRunningSessions,
    runningSessions,
    answersAsk
  }: z.infer<typeof AntigravityAccountSelectParams>,
  runtime: OrcaRuntimeService
): Promise<AntigravityAccountSelectResult> {
  const service = await getAntigravityAccountService(target)
  if (answersAsk) {
    return answerAntigravityTerminalsAsk(runtime, target, accountId, service)
  }
  // The sign-in writes agy's login itself; a switch now would race it.
  if (target.runtime === 'host' && antigravitySignInHoldsNativeLogin()) {
    throw new Error('Antigravity is signing in. Select an account after it finishes.')
  }
  // Undefined until agy's login is written; then the selection it replaced, which agy already
  // running in a terminal still holds (read in the same serialized step).
  const switched: { previous?: string | null } = {}
  // New chats use the account at once; running ones move at their next send (the selection
  // noted by the host's vault drives that).
  const state = await service
    .selectAccount(accountId, (previous) => {
      switched.previous = previous
    })
    .catch((error: unknown) => {
      // agy's login changed even though a check after the write failed: drop what described the old one.
      if (target.runtime === 'host' && switched.previous !== undefined) {
        forgetAgyLogin(runtime)
      }
      throw error
    })
  if (target.runtime === 'host') {
    // agy's login now verifiably holds it: chats a failed move held back follow at their next send.
    AGY_HOST_SELECTION.prepared({ key: accountId, target: accountId })
  }
  // Chats and terminals here run only on the host's agy; a WSL distro's run their own.
  if (target.runtime !== 'host' || switched.previous === undefined) {
    return withAntigravityChatBackend(runtime, target, state)
  }
  // What chats listed belongs to the previous account.
  forgetAgyLogin(runtime)
  const terminals = await runtime.onAntigravityAccountSwitched({
    from: switched.previous,
    to: accountId,
    ...(movesRunningSessions ? { movesRunningSessions } : {}),
    ...(runningSessions ? { runningSessions } : {})
  })
  return { ...(await withAntigravityChatBackend(runtime, target, state)), ...terminals }
}
