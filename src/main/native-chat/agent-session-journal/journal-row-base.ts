import { journalRowSchemaVersion } from '../../../shared/agent-session-journal-types'

export function journalRowBase(
  epoch: string,
  seq: number,
  fence: number,
  ts: number,
  bodies: readonly { kind: string }[] = []
): { v: number; epoch: string; seq: number; fence: number; ts: number } {
  return { v: journalRowSchemaVersion(bodies), epoch, seq, fence, ts }
}
