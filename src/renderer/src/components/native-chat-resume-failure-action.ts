import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import type { ResumeFailureAction } from './native-chat-resume-failure-guidance'
import { consumeNativeChatResumeOnRestartDialogRequest } from './native-chat-resume-on-restart-dialog'
import {
  continueNativeChatRestartOffers,
  dismissNativeChatRestartOffer
} from './native-chat-restart-offer-actions'
import type { MachineView } from './native-chat-resume-machine-views'

/** A dialog row's own action on one chat. Row actions act on their row and leave the dialog open,
 *  except Open, which gets out of the way of the chat it opens. */
export async function actOnResumeRow(
  machine: MachineView,
  action: ResumeFailureAction,
  sessionId: string,
  persistPreference: () => Promise<void>
): Promise<void> {
  if (action === 'dismiss') {
    await dismissNativeChatRestartOffer(machine.machine, [sessionId])
    return
  }
  if (action === 'retry') {
    void persistPreference()
    await continueNativeChatRestartOffers([{ machine: machine.machine, sessionIds: [sessionId] }])
    return
  }
  const failure = machine.failureFor(sessionId)
  if (!failure) {
    return
  }
  // Opening is read-only and keeps the record: the user's own send in that chat settles it.
  consumeNativeChatResumeOnRestartDialogRequest()
  await activateAiVaultStructuredSession({
    structuredSession: {
      workspaceId: failure.workspaceId,
      sessionId,
      // The machine that listed it and the pairing it listed under, never re-derived from
      // whichever workspace shares its id.
      executionHostId: failure.executionHostId,
      ...(machine.offer.fence.pairingRevision === undefined
        ? {}
        : { pairingRevision: machine.offer.fence.pairingRevision })
    }
  })
}
