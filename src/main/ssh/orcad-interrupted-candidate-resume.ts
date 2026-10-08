/**
 * Finishing an activation whose run ended after it launched the candidate, as that run would have:
 * the candidate commits only if it passes the same readiness gate, otherwise recovery undoes it.
 * Undoing first would stop a candidate that may already be serving and, once it changed state,
 * leave the host serving nothing until an operator accepts losing that state (P1-A).
 */
import type { ServeReadiness } from '../server/serve-readiness'
import { withActivatedVersion } from './orcad-activation-record'
import { writeOrcadActivationRecord } from './orcad-activation-record-store'
import type { OrcadActivateTransaction } from './orcad-activation-transaction'
import { writeOrcadActivationTransaction } from './orcad-activation-transaction-store'
import { withOrcadActivationCandidateReady } from './orcad-activation-transaction-transitions'
import { OrcadActiveReadinessError } from './orcad-active-readiness'
import {
  ensureOrcadSlotServing,
  orcadSlotDir,
  resolveOrcadSlotIdentity,
  slotLiveness,
  type OrcadSlotOptions
} from './orcad-recovery-slot'

/** Runs under a held fence. Null when the candidate cannot commit, so the caller undoes it. */
export async function resumeInterruptedOrcadCandidate(
  options: OrcadSlotOptions,
  transaction: OrcadActivateTransaction
): Promise<ServeReadiness | null> {
  const snapshotState = transaction.snapshot.state
  const incumbent = transaction.recordBefore.active
  if (
    transaction.phase !== 'snapshot-captured' ||
    // A journal from before the field cannot say which app started it; committing without that
    // drops the host-newer guard and lets an older desktop downgrade over migrated state.
    transaction.candidateAppVersion === undefined ||
    snapshotState === 'pending' ||
    // A serving incumbent holds the port and instance lock; undo keeps it.
    (incumbent !== null &&
      (await slotLiveness(options, orcadSlotDir(options, incumbent))) !== 'DEAD')
  ) {
    return null
  }
  const candidate = await resolveOrcadSlotIdentity(options, transaction.candidateVersion)
  // An unprovable candidate process is left to undo, which rules it out before anything starts.
  if ((await slotLiveness(options, candidate.remoteDir)) === 'UNKNOWN') {
    return null
  }
  let readiness: ServeReadiness
  try {
    readiness = await ensureOrcadSlotServing(options, candidate)
  } catch (error) {
    // Only a verdict about the candidate sends it to undo; an unanswered host keeps the fence.
    if (error instanceof OrcadActiveReadinessError && error.verdict !== 'unverifiable') {
      return null
    }
    throw error
  }
  const now = new Date()
  const recordAfter = withActivatedVersion(
    transaction.recordBefore,
    transaction.candidateVersion,
    snapshotState === 'captured'
      ? {
          dirName: transaction.snapshot.dirName,
          takenBeforeVersion: transaction.candidateVersion,
          readableByVersion: incumbent,
          takenAt: transaction.startedAt
        }
      : null,
    now,
    transaction.candidateAppVersion ?? undefined
  )
  await writeOrcadActivationTransaction(
    options,
    withOrcadActivationCandidateReady(transaction, recordAfter, now)
  )
  await writeOrcadActivationRecord(options, recordAfter)
  return readiness
}
