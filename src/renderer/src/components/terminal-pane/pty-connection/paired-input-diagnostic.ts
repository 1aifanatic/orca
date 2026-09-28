import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { isPaneReplaying } from '../replay-guard'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'

export function tracePairedInput(
  session: ConnectPanePtySession,
  data: string,
  wasUserInput: boolean,
  stage: string
): void {
  console.warn(
    'INPUT_FORWARD_PROBE',
    JSON.stringify({
      stage,
      data,
      wasUserInput,
      replaying: isPaneReplaying(session.deps.replayingPanesRef, session.pane.id),
      tabId: session.deps.tabId,
      pty: session.transport.getPtyId(),
      locked: isPtyLocked(session.transport.getPtyId() ?? ''),
      deferred: Boolean(session.deps.deferPtyInput)
    })
  )
}
