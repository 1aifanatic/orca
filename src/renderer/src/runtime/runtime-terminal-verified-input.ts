import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { RuntimeTerminalSend } from '../../../shared/runtime-types'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { isTerminalInputTooLargeWithDeferredMeasurement } from '../../../shared/terminal-input'
import {
  hasLegacyTerminalSendHandoff,
  readTerminalSendAcknowledgment,
  TerminalSendAcknowledgmentUnavailableError
} from '../../../shared/terminal-send-acknowledgment'
import { classifyTerminalProcessInspectionFailure } from '../../../shared/terminal-process-inspection'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from './runtime-terminal-stream'
import { recordRuntimeTerminalInputForPtyId } from './runtime-terminal-input-recording'

const DESKTOP_RUNTIME_CLIENT = { id: 'orca-desktop', type: 'desktop' } as const

/** True means acknowledged acceptance, false means refusal; a lost acknowledgment rejects. */
export async function sendRuntimePtyInputVerified(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind
): Promise<boolean> {
  const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
  if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
    return false
  }
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const target = ownerEnvironmentId
    ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
    : getActiveRuntimeTarget(settings)
  const terminal = getRemoteRuntimeTerminalHandle(ptyId)
  if (target.kind !== 'environment' || !terminal) {
    const accepted = await window.api.pty.writeAccepted(ptyId, data, inputKind)
    if (accepted) {
      recordRuntimeTerminalInputForPtyId(ptyId)
    }
    return accepted
  }

  try {
    const result = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
      target,
      'terminal.send',
      { terminal, text: data, client: DESKTOP_RUNTIME_CLIENT, requireWriteSettlement: true },
      { timeoutMs: 15_000 }
    )
    if (result.send.accepted === true) {
      recordRuntimeTerminalInputForPtyId(ptyId)
    }
    const acknowledgment = readTerminalSendAcknowledgment(result)
    if (acknowledgment === 'unverifiable') {
      throw new TerminalSendAcknowledgmentUnavailableError(hasLegacyTerminalSendHandoff(result))
    }
    return acknowledgment === 'accepted'
  } catch (error) {
    if (classifyTerminalProcessInspectionFailure(error) === 'terminal_gone') {
      return false
    }
    throw error
  }
}

/** Older hosts confirm whole-write handoff only; ordinary sequences can finish without resending. */
export async function sendRuntimePtyInputForSequence(
  ...args: Parameters<typeof sendRuntimePtyInputVerified>
): Promise<boolean> {
  try {
    return await sendRuntimePtyInputVerified(...args)
  } catch (error) {
    if (
      error instanceof TerminalSendAcknowledgmentUnavailableError &&
      error.legacyHandoffCompleted
    ) {
      return true
    }
    throw error
  }
}
