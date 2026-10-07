// The document a native-chat visual runs as: one string builder every client wraps author HTML
// with, so the policy, theme handoff and frame messages cannot drift between desktop, web and
// mobile. Each client puts the result in an opaque `sandbox="allow-scripts"` frame and keeps the
// security decisions about what the frame may ask for on its own side.

/** Public CDNs a visual may load scripts, styles, fonts and images from. Pinned on purpose. */
export const NATIVE_CHAT_VISUAL_CDN_ORIGINS = [
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
  'https://esm.sh',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com'
] as const

const CDN = NATIVE_CHAT_VISUAL_CDN_ORIGINS.join(' ')

/**
 * Network-closed except for CDN assets: no fetch/XHR/WebSocket, no nested frames, workers, plugins,
 * media, forms or base rewrites. A request to an allowed CDN can still carry data in its URL; that
 * is an accepted, disclosed risk, not a confidentiality guarantee.
 */
export const NATIVE_CHAT_VISUAL_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' data: blob: ${CDN}`,
  `style-src 'unsafe-inline' data: blob: ${CDN}`,
  `font-src data: blob: ${CDN}`,
  `img-src data: blob: ${CDN}`,
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

export const NATIVE_CHAT_VISUAL_MIN_HEIGHT = 80
export const NATIVE_CHAT_VISUAL_MAX_HEIGHT = 2000
const MAX_LINK_LENGTH = 2048

/** Theme variables a visual may style against: the panel design tokens plus the chart series. */
export const NATIVE_CHAT_VISUAL_THEME_VARIABLES = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--border',
  '--input',
  '--ring',
  '--radius',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--font-sans',
  '--font-mono'
] as const

export type NativeChatVisualThemeVariable = (typeof NATIVE_CHAT_VISUAL_THEME_VARIABLES)[number]

export type NativeChatVisualTheme = {
  colorScheme: 'light' | 'dark'
  variables: Readonly<Partial<Record<NativeChatVisualThemeVariable, string>>>
}

const MESSAGE_TYPE = {
  height: 'orca-visual:height',
  openLink: 'orca-visual:open-link',
  theme: 'orca-visual:theme'
} as const

export type NativeChatVisualFrameMessage =
  | { kind: 'height'; height: number }
  | { kind: 'open-link'; url: string }

// Why: values land inside a <style> element; anything that could close the rule or the element
// (`<`, `>`, `{`, `}`, `;`, `\`) is outside this set, so it is refused rather than escaped.
const SAFE_THEME_VALUE = /^[#\w\s(),.%/'"+-]{1,200}$/

function themeVariables(theme: NativeChatVisualTheme): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const name of NATIVE_CHAT_VISUAL_THEME_VARIABLES) {
    const value = theme.variables[name]
    if (value !== undefined && SAFE_THEME_VALUE.test(value)) {
      variables[name] = value
    }
  }
  return variables
}

function themeDeclarations(theme: NativeChatVisualTheme): string {
  return Object.entries(themeVariables(theme))
    .map(([name, value]) => `${name}:${value}`)
    .join(';')
}

/** Parent -> frame: a live theme change, applied without reloading the document. */
export function nativeChatVisualThemeMessage(theme: NativeChatVisualTheme): {
  type: string
  colorScheme: 'light' | 'dark'
  variables: Record<string, string>
} {
  return {
    type: MESSAGE_TYPE.theme,
    colorScheme: theme.colorScheme,
    variables: themeVariables(theme)
  }
}

const PRELUDE = `(function () {
'use strict'
var parent = window.parent
function post(message) { try { parent.postMessage(message, '*') } catch (_) {} }
if (window.navigation && typeof window.navigation.addEventListener === 'function') {
  window.navigation.addEventListener('navigate', function (event) {
    if (event.cancelable && !event.hashChange) event.preventDefault()
  })
}
try { Object.defineProperty(window, 'open', { value: function () { return null }, writable: false, configurable: false }) }
catch (_) { try { window.open = function () { return null } } catch (_) {} }
window.addEventListener('click', function (event) {
  var node = event.target
  while (node && node !== document) {
    if (node.nodeType === 1 && (node.tagName === 'A' || node.tagName === 'AREA') && node.hasAttribute('href')) {
      var raw = node.getAttribute('href') || ''
      if (raw.charAt(0) === '#') return
      event.preventDefault()
      if (/^https?:/i.test(node.href)) post({ type: '${MESSAGE_TYPE.openLink}', url: String(node.href) })
      return
    }
    node = node.parentNode
  }
}, true)
window.addEventListener('submit', function (event) { event.preventDefault() }, true)
var last = 0
var queued = false
// The body's own extent: the root's scrollHeight never drops below the frame, so it cannot shrink.
function measure() {
  queued = false
  var b = document.body
  var height = document.documentElement.scrollHeight
  if (b) {
    var rect = b.getBoundingClientRect()
    var top = rect.top + window.scrollY
    height = Math.max(top + b.scrollHeight, rect.bottom + window.scrollY) + (parseFloat(getComputedStyle(b).marginBottom) || 0)
  }
  height = Math.ceil(height)
  if (height !== last) { last = height; post({ type: '${MESSAGE_TYPE.height}', height: height }) }
}
function schedule() {
  if (queued) return
  queued = true
  ;(window.requestAnimationFrame || setTimeout)(measure)
}
if (typeof ResizeObserver === 'function') {
  var observer = new ResizeObserver(schedule)
  observer.observe(document.documentElement)
  document.addEventListener('DOMContentLoaded', function () { if (document.body) observer.observe(document.body) })
}
document.addEventListener('DOMContentLoaded', schedule)
window.addEventListener('load', schedule)
if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule, function () {})
window.addEventListener('message', function (event) {
  var data = event.data
  if (event.source !== parent || !data || data.type !== '${MESSAGE_TYPE.theme}') return
  var root = document.documentElement
  root.style.colorScheme = data.colorScheme === 'light' ? 'light' : 'dark'
  var names = ${JSON.stringify(NATIVE_CHAT_VISUAL_THEME_VARIABLES)}
  for (var i = 0; i < names.length; i++) {
    var value = data.variables && data.variables[names[i]]
    if (typeof value === 'string') root.style.setProperty(names[i], value)
  }
})
schedule()
})()`

/**
 * The frame document for one visual: the policy first (a CSP meta applies from the moment it
 * parses and a later one can only tighten it), the theme, the prelude that reports height, routes
 * links to the parent and refuses navigation, then the author's HTML, which merges into the open
 * head/html.
 */
export function buildNativeChatVisualDocument(html: string, theme: NativeChatVisualTheme): string {
  const scheme = theme.colorScheme === 'light' ? 'light' : 'dark'
  const base =
    ':where(body){margin:0;color:var(--foreground);font-family:var(--font-sans,system-ui,sans-serif)}'
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${NATIVE_CHAT_VISUAL_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{color-scheme:${scheme};${themeDeclarations(theme)}}${base}</style>
<script>${PRELUDE}</script>
</head>
${html}`
}

function finiteHeight(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null
  }
  return Math.min(
    NATIVE_CHAT_VISUAL_MAX_HEIGHT,
    Math.max(NATIVE_CHAT_VISUAL_MIN_HEIGHT, Math.round(value))
  )
}

/** An http(s) URL a visual may ask the viewer to open, normalized, or null. */
export function nativeChatVisualOpenableUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LINK_LENGTH) {
    return null
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    return null
  }
  return url.href
}

/** A frame -> parent message, validated; anything else is null and must be ignored. */
export function parseNativeChatVisualFrameMessage(
  data: unknown
): NativeChatVisualFrameMessage | null {
  if (typeof data !== 'object' || data === null || !('type' in data)) {
    return null
  }
  if (data.type === MESSAGE_TYPE.height && 'height' in data) {
    const height = finiteHeight(data.height)
    return height === null ? null : { kind: 'height', height }
  }
  if (data.type === MESSAGE_TYPE.openLink && 'url' in data) {
    const url = nativeChatVisualOpenableUrl(data.url)
    return url === null ? null : { kind: 'open-link', url }
  }
  return null
}
