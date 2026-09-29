// Codex readiness from its startup screens: the provisional screen must never count as ready.

export function findCodexReadyPromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('openai codex')
  if (headerIndex === -1) {
    return null
  }
  const readySegment = normalized.slice(headerIndex)
  // Why: Codex prints permissions only in YOLO mode; the stable ready header is OpenAI Codex + model + directory.
  return readySegment.includes('model:') && readySegment.includes('directory:') ? headerIndex : null
}

const CODEX_HEADER_LOADING_RE = /(?:model|directory):\s+loading/
// Codex 0.158+ greeting layout: an unboxed `>_ OpenAI Codex (vX)` row, then the bare directory.
const CODEX_COMPACT_HEADER_RE = /^\s*>_ openai codex \(v[^)]*\)\s*$/m

// Why the header box only: chat below it can mention "OpenAI Codex" or `model: loading`.
function readCodexHeaderBox(screen: string): { index: number; header: string } | null {
  const index = screen.indexOf('openai codex')
  if (index === -1) {
    return null
  }
  const boxEnd = screen.indexOf('╰', index)
  return { index, header: screen.slice(index, boxEnd === -1 ? undefined : boxEnd) }
}

// Why the status row too: on a grid out of step with the PTY, stale `loading` cells can outlive the
// repaint, while fragments of the live status row still land below the header.
export function isCodexProvisionalStartupScreen(screen: string): boolean {
  const box = readCodexHeaderBox(screen)
  return (
    box !== null &&
    CODEX_HEADER_LOADING_RE.test(box.header) &&
    !hasCodexLiveStatusRowBelow(screen, box.index + box.header.length)
  )
}

// Why: only Codex's live chat fills the status row under the composer (default items: model,
// directory, thread, joined by ` · `); the provisional startup screen shows just its own hints.
function hasCodexLiveStatusRowBelow(screen: string, from: number): boolean {
  return screen
    .slice(from)
    .split('\n')
    .some((row) => row.includes(' · ') && !row.includes('waiting for startup'))
}

// Why `loading`: a header still loading is not ready; the screen must not add readiness early.
export function findCodexScreenReadyPromptIndex(screen: string): number | null {
  const compactHeader = CODEX_COMPACT_HEADER_RE.exec(screen)
  if (compactHeader) {
    return findCodexCompactScreenReadyIndex(screen, compactHeader.index + compactHeader[0].length)
      ? compactHeader.index
      : null
  }
  const box = readCodexHeaderBox(screen)
  if (!box) {
    return null
  }
  return box.header.includes('model:') &&
    box.header.includes('directory:') &&
    !CODEX_HEADER_LOADING_RE.test(box.header)
    ? box.index
    : null
}

// Why the status row: the compact header looks the same on the provisional startup screen, which
// can still give way to a startup dialog (model announcement) before the live chat takes over.
function findCodexCompactScreenReadyIndex(screen: string, headerEnd: number): boolean {
  const directory = screen
    .slice(headerEnd)
    .split('\n')
    .find((row) => row.trim() !== '')
    ?.trim()
  return (
    Boolean(directory) && directory !== 'loading' && hasCodexLiveStatusRowBelow(screen, headerEnd)
  )
}
