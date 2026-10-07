import {
  holdNotesForSend,
  isNoteInFlight,
  useNotesInFlightVersion
} from '@/lib/notes-send-in-flight'

// The holds notes use, for review threads a launch still on its way will resolve: a thread shown as
// selectable meanwhile could be sent twice.
const key = (groupId: string): string => `pr-comment-group:${groupId}`

export function holdPRCommentGroupsForSend(
  groupIds: readonly string[],
  settled: Promise<unknown>
): void {
  holdNotesForSend(groupIds.map(key), settled)
}

export function isPRCommentGroupInFlight(groupId: string): boolean {
  return isNoteInFlight(key(groupId))
}

/** Changes whenever a hold starts or ends, for memos that filter by `isPRCommentGroupInFlight`. */
export const usePRCommentGroupsInFlightVersion = useNotesInFlightVersion
