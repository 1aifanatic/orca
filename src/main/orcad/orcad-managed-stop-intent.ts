import { join } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-idle-exit'
import type { OrcadManagedStopRequest } from '../../shared/orcad-stop-request'
import {
  ORCAD_ACTIVATION_TRANSACTION_FILENAME,
  parseOrcadActivationTransaction
} from '../ssh/orcad-activation-transaction'
import { sameOrcadManagedStopInstance } from './orcad-managed-stop-request'

/** Older Settings stops carry their intent in the existing decommission transaction. */
export function orcadManagedStopIsUserRequested(
  request: OrcadManagedStopRequest,
  activationRoot = process.env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV]
): boolean {
  if (request.intent === 'user') {
    return true
  }
  if (!activationRoot) {
    return false
  }
  try {
    const { buffer } = readNodeFileSyncWithinLimit(
      join(activationRoot, ORCAD_ACTIVATION_TRANSACTION_FILENAME),
      64 * 1024
    )
    const parsed = parseOrcadActivationTransaction(buffer.toString('utf8'))
    if (parsed.state !== 'ok') {
      return false
    }
    const transaction = parsed.transaction
    return (
      transaction.operation === 'decommission' &&
      transaction.phase === 'stop-dispatched' &&
      transaction.transactionId === request.transactionId &&
      transaction.request !== null &&
      transaction.request.runtimeId === request.runtimeId &&
      transaction.request.version === request.version &&
      sameOrcadManagedStopInstance(transaction.request.instance, request.instance)
    )
  } catch {
    return false
  }
}
