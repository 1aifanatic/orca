/** Missing or future proof stays unconfirmed, including a legacy raw accepted reply. */
export function readTerminalSendAcknowledgment(
  result: unknown
): 'accepted' | 'refused' | 'unverifiable' {
  if (typeof result !== 'object' || result === null || !('send' in result)) {
    return 'unverifiable'
  }
  const send = result.send
  if (typeof send !== 'object' || send === null) {
    return 'unverifiable'
  }
  if ('writeSettlement' in send) {
    const settlement = send.writeSettlement
    if (typeof settlement === 'object' && settlement !== null && 'outcome' in settlement) {
      if (settlement.outcome === 'refused') {
        return 'refused'
      }
      if (settlement.outcome === 'accepted' && 'accepted' in send && send.accepted === true) {
        return 'accepted'
      }
    }
    return 'unverifiable'
  }
  return 'accepted' in send && send.accepted === false ? 'refused' : 'unverifiable'
}
export class TerminalSendAcknowledgmentUnavailableError extends Error {
  constructor(readonly legacyHandoffCompleted: boolean) {
    super('PTY write acknowledgment unavailable')
  }
}

/** Legacy acceptance confirms whole-write handoff, without provider acknowledgment. */
export function hasLegacyTerminalSendHandoff(result: unknown): boolean {
  if (typeof result !== 'object' || result === null || !('send' in result)) {
    return false
  }
  const send = result.send
  return (
    typeof send === 'object' &&
    send !== null &&
    'accepted' in send &&
    send.accepted === true &&
    !('writeSettlement' in send)
  )
}
