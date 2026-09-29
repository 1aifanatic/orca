/** Minimal shape shared by React's synthetic ClipboardEvent and the native DOM
 *  ClipboardEvent — the pane-level listener delivers the native one. */
export type ClipboardEventLike = {
  clipboardData: DataTransfer | null
  preventDefault: () => void
  defaultPrevented: boolean
}

export function clipboardEventImageFile(event: ClipboardEventLike): File | null {
  const data = event.clipboardData
  if (!data) {
    return null
  }
  const item = Array.from(data.items).find((candidate) => candidate.type.startsWith('image/'))
  return item?.getAsFile() ?? null
}

/**
 * The event's text/plain, unless it only names the copied files: a file-manager
 * copy labels each file with its name, which is not prompt text when the file
 * itself is being attached.
 */
export function clipboardEventPromptText(
  event: ClipboardEventLike,
  attachingFile: boolean
): string {
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (!attachingFile || !text) {
    return text
  }
  const names = Array.from(event.clipboardData?.files ?? [], (file) => file.name).sort()
  const lines = text
    .trim()
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .sort()
  const labelsFiles = lines.length === names.length && lines.every((line, i) => line === names[i])
  return labelsFiles ? '' : text
}
