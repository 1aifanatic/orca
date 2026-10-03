export function getMarkdownPreviewAnchorScrollTop(
  container: Pick<HTMLElement, 'getBoundingClientRect' | 'scrollTop'>,
  target: Pick<HTMLElement, 'getBoundingClientRect'>,
  align: 'start' | 'center' = 'start'
): number {
  const viewport = container.getBoundingClientRect()
  const bounds = target.getBoundingClientRect()
  const offset = align === 'center' ? (viewport.height - bounds.height) / 2 : 12
  return Math.max(0, bounds.top - viewport.top + container.scrollTop - offset)
}

export function decodeMarkdownPreviewAnchor(rawAnchor: string): string {
  try {
    return decodeURIComponent(rawAnchor)
  } catch {
    return rawAnchor
  }
}
