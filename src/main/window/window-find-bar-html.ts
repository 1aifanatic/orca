import { WINDOW_FIND_MAX_TEXT_LENGTH } from '../../shared/window-find-bar-contract'

export const WINDOW_FIND_BAR_VIEW_WIDTH = 344
export const WINDOW_FIND_BAR_VIEW_HEIGHT = 48
// Transparent margin around the bar so its shadow is not clipped by the view bounds.
export const WINDOW_FIND_BAR_VIEW_INSET = 8

const CHEVRON_UP_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 14.5 12 8l7 6.5"/></svg>'
const CHEVRON_DOWN_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9.5 12 16l7-6.5"/></svg>'
const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'

// Colors mirror the popover tokens in src/renderer/src/assets/main.css; a data: URL page cannot
// import that stylesheet. Labels arrive from main on every open so they follow the UI language.
const WINDOW_FIND_BAR_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; overflow: hidden; background: transparent; color: #0a0a0a;
    font: 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, sans-serif;
    -webkit-user-select: none; user-select: none; cursor: default;
  }
  .bar {
    display: flex; align-items: center; gap: 2px;
    height: ${WINDOW_FIND_BAR_VIEW_HEIGHT - WINDOW_FIND_BAR_VIEW_INSET * 2}px;
    margin: ${WINDOW_FIND_BAR_VIEW_INSET}px; padding: 0 4px 0 10px;
    background: #fff; border: 1px solid #e5e5e5; border-radius: 8px;
    box-shadow: 0 4px 12px rgb(0 0 0 / 0.12);
  }
  input {
    flex: 1 1 auto; min-width: 0; border: 0; outline: none; background: transparent;
    color: inherit; font: inherit; -webkit-user-select: text; user-select: text;
  }
  input::placeholder, .count { color: #737373; }
  .count { flex: 0 0 auto; padding: 0 4px; font-variant-numeric: tabular-nums; }
  .count[data-empty="true"] { color: #e40014; }
  button {
    display: flex; align-items: center; justify-content: center; flex: 0 0 auto;
    width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px;
    background: transparent; color: #737373;
  }
  button:hover:not(:disabled) { background: #f5f5f5; color: #0a0a0a; }
  button:disabled { opacity: 0.4; }
  svg {
    width: 14px; height: 14px; fill: none; stroke: currentColor;
    stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #fafafa; }
    .bar { background: #171717; border-color: rgb(255 255 255 / 0.15); box-shadow: 0 4px 12px rgb(0 0 0 / 0.4); }
    input::placeholder, .count { color: #a1a1a1; }
    .count[data-empty="true"] { color: #ff6568; }
    button { color: #a1a1a1; }
    button:hover:not(:disabled) { background: #404040; color: #fafafa; }
  }
</style></head><body>
<div class="bar" role="search">
  <input id="find-input" type="text" autocomplete="off" spellcheck="false" maxlength="${WINDOW_FIND_MAX_TEXT_LENGTH}">
  <span id="find-count" class="count" role="status" aria-live="polite"></span>
  <button type="button" data-step="previous" disabled>${CHEVRON_UP_ICON}</button>
  <button type="button" data-step="next" disabled>${CHEVRON_DOWN_ICON}</button>
  <button type="button" data-action="close">${CLOSE_ICON}</button>
</div>
</body></html>`

export function createWindowFindBarUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(WINDOW_FIND_BAR_HTML)}`
}
