/**
 * The named text anchor `codex-provisional-startup`: the last Codex header while it still reads
 * `model: loading`, which 0.157 paints while its daemon starts and discards input typed behind.
 *
 * Why the text copy: 0.157 leaves its alternate screen while it starts its daemon, so the live
 * screen shows no header then, while the text copy keeps the provisional one until the live chat
 * paints its footer after it (a later model repaint rewrites only the value, never the label).
 * Why `·`: every live footer row draws one (status row, `← for agents · ?`, `⚠ N warning · f2`);
 * startup dialogs draw one too, which is why startup-dialog-blocked-signals.ts matches them first.
 */
export function findCodexProvisionalStartupIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('openai codex')
  if (headerIndex === -1) {
    return null
  }
  const loading = /model:\s+loading/.exec(normalized.slice(headerIndex))
  return loading !== null && !normalized.includes('·', headerIndex + loading.index)
    ? headerIndex
    : null
}
