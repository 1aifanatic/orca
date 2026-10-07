import {
  NATIVE_CHAT_VISUAL_CSP,
  NATIVE_CHAT_VISUAL_MAX_HEIGHT,
  NATIVE_CHAT_VISUAL_MIN_HEIGHT
} from '../../../src/shared/native-chat-visual-document'
import { inlineScriptLiteral } from '../components/inline-script-json'

/** `inline` sizes the frame to its reported height; `fullscreen` fills the screen and the page scrolls. */
export type MobileNativeChatVisualHostMode = 'inline' | 'fullscreen'

export const MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT = 160

/**
 * The trusted document the WebView loads. A native WebView's top document gets no `sandbox`, and
 * on both platforms the native message channel is reachable from every frame in it, so the author
 * HTML never runs here: it runs in an opaque `sandbox="allow-scripts"` srcdoc child, and this
 * document is the only thing that talks to the app.
 *
 * - Every native message carries `token`, which only this document knows; the app drops anything
 *   else, which is how a child that reaches the native channel directly is refused.
 * - Only messages whose `source` is the child's window are relayed, and only as data for the app
 *   to validate. A link request is relayed only while the page holds user activation.
 * - A second `load` of the child means it navigated away from its document: the frame is removed
 *   and the app told, so a replacement document never inherits the frame.
 *
 * The child inherits this document's policy (a srcdoc frame has no URL of its own) and adds the
 * same policy from its own meta, so this document carries the visual policy too.
 */
export function buildMobileNativeChatVisualHostDocument(input: {
  visualDocument: string
  token: string
  title: string
  mode: MobileNativeChatVisualHostMode
}): string {
  const frameHeight =
    input.mode === 'fullscreen' ? '100vh' : `${MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT}px`
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${NATIVE_CHAT_VISUAL_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}iframe{display:block;border:0;width:100%;height:${frameHeight};background:transparent}</style>
</head>
<body>
<script>
(function () {
'use strict'
var token = ${inlineScriptLiteral(input.token)}
var fullscreen = ${inlineScriptLiteral(input.mode === 'fullscreen')}
var channel = window.ReactNativeWebView
function send(message) {
  message.token = token
  if (channel) channel.postMessage(JSON.stringify(message))
}
var frame = document.createElement('iframe')
frame.setAttribute('sandbox', 'allow-scripts')
frame.setAttribute('referrerpolicy', 'no-referrer')
frame.setAttribute('title', ${inlineScriptLiteral(input.title)})
var loads = 0
frame.addEventListener('load', function () {
  loads += 1
  if (loads > 1) {
    frame.remove()
    send({ kind: 'escaped' })
  }
})
window.addEventListener('message', function (event) {
  if (!frame.contentWindow || event.source !== frame.contentWindow) return
  var data = event.data
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return
  if (data.type === 'orca-visual:height') {
    if (fullscreen) return
    var height = Number(data.height)
    if (!isFinite(height)) return
    frame.style.height = Math.min(${NATIVE_CHAT_VISUAL_MAX_HEIGHT}, Math.max(${NATIVE_CHAT_VISUAL_MIN_HEIGHT}, Math.round(height))) + 'px'
    send({ kind: 'frame', data: { type: data.type, height: height } })
    return
  }
  if (data.type === 'orca-visual:open-link') {
    var activation = navigator.userActivation
    if (!activation || !activation.isActive) return
    send({ kind: 'frame', data: { type: data.type, url: String(data.url).slice(0, 4096) } })
  }
})
frame.srcdoc = ${inlineScriptLiteral(input.visualDocument)}
document.body.appendChild(frame)
})()
</script>
</body>
</html>`
}
