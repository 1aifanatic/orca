import type { Tab } from '../../../../../../shared/tab-types'

export type EditorTabContentType = Extract<
  Tab['contentType'],
  'editor' | 'diff' | 'conflict-review' | 'check-details' | 'chat-visual'
>

export function isEditorTabContentType(
  contentType: Tab['contentType']
): contentType is EditorTabContentType {
  return (
    contentType === 'editor' ||
    contentType === 'diff' ||
    contentType === 'conflict-review' ||
    contentType === 'check-details' ||
    contentType === 'chat-visual'
  )
}
