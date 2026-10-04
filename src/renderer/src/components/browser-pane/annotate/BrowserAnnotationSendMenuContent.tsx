import React from 'react'
import { ReviewNotesSendMenuContent } from '@/components/editor/ReviewNotesSendMenuContent'
import type { NotesSendHandOff } from '@/lib/notes-send-in-flight'

export type BrowserAnnotationSendMenuContentProps = {
  worktreeId: string
  groupId: string
  prompt: string
  onPromptDelivered?: () => void
  notesHandOff?: NotesSendHandOff
}

export function BrowserAnnotationSendMenuContent({
  worktreeId,
  groupId,
  prompt,
  onPromptDelivered,
  notesHandOff
}: BrowserAnnotationSendMenuContentProps): React.JSX.Element {
  return (
    <ReviewNotesSendMenuContent
      worktreeId={worktreeId}
      groupId={groupId}
      prompt={prompt}
      // Why: keep browser-annotation delivery and telemetry stable even if
      // the shared review-notes menu defaults change later.
      promptDelivery="submit-after-ready"
      launchSource="notes_send"
      onPromptDelivered={onPromptDelivered}
      notesHandOff={notesHandOff}
    />
  )
}
