export function focusRichMarkdownEditorFromSearch(
  event: MouseEvent,
  editorDom: HTMLElement | null
): void {
  if (!editorDom || event.defaultPrevented || event.button !== 0) {
    return
  }

  const target = event.target
  if (!(target instanceof Element) || !editorDom.contains(target)) {
    return
  }

  const root = editorDom.closest('.rich-markdown-editor-shell')
  const activeElement = editorDom.ownerDocument.activeElement
  if (
    !root ||
    !activeElement?.closest('.rich-markdown-search') ||
    activeElement.closest('.rich-markdown-editor-shell') !== root
  ) {
    return
  }

  const control = target.closest('button, input, textarea, select, [contenteditable="false"]')
  if (control && editorDom.contains(control)) {
    return
  }

  // Native focus preserves the browser's upcoming click or drag selection.
  editorDom.focus({ preventScroll: true })
}
