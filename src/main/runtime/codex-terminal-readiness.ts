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

// Why: Codex repaints its whole screen, header included, once a startup dialog closes, and the
// dialog never draws the header; 0.158's header has no labels, so the header alone marks it answered.
export function findCodexHeaderIndex(normalized: string): number | null {
  const index = normalized.lastIndexOf('openai codex (v')
  return index === -1 ? null : index
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

// Why the text copy: Codex 0.157 leaves its alternate screen while it starts its daemon, so the live
// screen shows no header then; the text copy keeps the provisional header until the live chat paints
// its footer after it (a later model repaint rewrites only the value, never the `model:` label).
export function isCodexProvisionalStartupText(normalized: string): boolean {
  const headerIndex = normalized.lastIndexOf('openai codex')
  if (headerIndex === -1) {
    return false
  }
  const loading = /model:\s+loading/.exec(normalized.slice(headerIndex))
  return loading !== null && !hasCodexLiveFooterBelow(normalized, headerIndex + loading.index)
}

// Why: only Codex's live chat draws a `·` under the composer: the status row (items joined by `·`),
// `← for agents · ? for shortcuts` on daemon sessions, or `⚠ N warning · f2 to view`.
function hasCodexLiveFooterBelow(text: string, from: number): boolean {
  return text.includes('·', from)
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

// Why the live footer: the compact header looks the same on the provisional startup screen, which
// can still give way to a startup dialog (model announcement) before the live chat takes over.
function findCodexCompactScreenReadyIndex(screen: string, headerEnd: number): boolean {
  const directory = screen
    .slice(headerEnd)
    .split('\n')
    .find((row) => row.trim() !== '')
    ?.trim()
  return Boolean(directory) && directory !== 'loading' && hasCodexLiveFooterBelow(screen, headerEnd)
}
