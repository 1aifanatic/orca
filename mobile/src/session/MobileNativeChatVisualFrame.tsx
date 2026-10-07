import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes'
import * as ExpoCrypto from 'expo-crypto'
import { buildNativeChatVisualDocument } from '../../../src/shared/native-chat-visual-document'
import { openExternalLink } from '../platform/external-link'
import {
  MOBILE_NATIVE_CHAT_VISUAL_LINK_INTERVAL_MS,
  readMobileNativeChatVisualBridgeMessage
} from './mobile-native-chat-visual-bridge'
import {
  buildMobileNativeChatVisualHostDocument,
  MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT,
  type MobileNativeChatVisualHostMode
} from './mobile-native-chat-visual-host-document'
import { MOBILE_NATIVE_CHAT_VISUAL_THEME } from './mobile-native-chat-visual-theme'

export type MobileNativeChatVisualFrameProps = {
  html: string
  title: string
  mode: MobileNativeChatVisualHostMode
  /** The frame cannot show this visual (it navigated away, or its web process keeps dying). */
  onFailed: () => void
}

/** Height reports are applied at most this often, so a page resizing every frame cannot thrash layout. */
const HEIGHT_APPLY_INTERVAL_MS = 100
/** One automatic reload after the web process dies; a page that kills it again is unavailable. */
const MAX_PROCESS_RESTARTS = 1

function newBridgeToken(): string {
  return Array.from(ExpoCrypto.getRandomBytes(16), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

// Only the host document and its srcdoc child ever load. A visual's links reach the app through the
// bridge instead, so every other navigation, top frame or child, is refused rather than opened.
function allowsLoad(request: ShouldStartLoadRequest): boolean {
  return request.url === 'about:blank' || request.url === 'about:srcdoc'
}

/**
 * One visual in a WebView: a trusted host document with the author HTML in an opaque sandboxed
 * child (see `buildMobileNativeChatVisualHostDocument`). The app accepts exactly two requests from
 * it, each token-checked and validated here: a clamped height and an http(s) link to open.
 */
export const MobileNativeChatVisualFrame = memo(function MobileNativeChatVisualFrame({
  html,
  title,
  mode,
  onFailed
}: MobileNativeChatVisualFrameProps) {
  const [token] = useState(newBridgeToken)
  const [generation, setGeneration] = useState(0)
  const [height, setHeight] = useState(MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT)
  const restarts = useRef(0)
  const lastLinkAt = useRef(0)
  const pendingHeight = useRef<number | null>(null)
  const heightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const document = useMemo(
    () =>
      buildMobileNativeChatVisualHostDocument({
        visualDocument: buildNativeChatVisualDocument(html, MOBILE_NATIVE_CHAT_VISUAL_THEME),
        token,
        title,
        mode
      }),
    [html, token, title, mode]
  )
  const source = useMemo(() => ({ html: document }), [document])

  useEffect(
    () => () => {
      if (heightTimer.current) {
        clearTimeout(heightTimer.current)
      }
    },
    []
  )

  const applyHeight = useCallback((next: number) => {
    pendingHeight.current = next
    if (heightTimer.current) {
      return
    }
    heightTimer.current = setTimeout(() => {
      heightTimer.current = null
      const latest = pendingHeight.current
      if (latest !== null) {
        setHeight((current) => (Math.abs(current - latest) < 1 ? current : latest))
      }
    }, HEIGHT_APPLY_INTERVAL_MS)
  }, [])

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = readMobileNativeChatVisualBridgeMessage(event.nativeEvent.data, token)
      if (!message) {
        return
      }
      if (message.kind === 'escaped') {
        onFailed()
        return
      }
      if (message.kind === 'height') {
        if (mode === 'inline') {
          applyHeight(message.height)
        }
        return
      }
      const now = Date.now()
      if (now - lastLinkAt.current < MOBILE_NATIVE_CHAT_VISUAL_LINK_INTERVAL_MS) {
        return
      }
      lastLinkAt.current = now
      openExternalLink(message.url)
    },
    [token, mode, applyHeight, onFailed]
  )

  const restart = useCallback(() => {
    if (restarts.current >= MAX_PROCESS_RESTARTS) {
      onFailed()
      return
    }
    restarts.current += 1
    setGeneration((value) => value + 1)
  }, [onFailed])

  return (
    <WebView
      key={generation}
      source={source}
      style={mode === 'inline' ? [styles.inline, { height }] : styles.fullscreen}
      accessibilityLabel={title}
      // '*' so every navigation reaches `allowsLoad`: an origin outside this list is opened in the
      // system browser by the WebView library itself, with no gesture check.
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={allowsLoad}
      javaScriptEnabled
      javaScriptCanOpenWindowsAutomatically={false}
      setSupportMultipleWindows={false}
      domStorageEnabled={false}
      allowFileAccess={false}
      allowsLinkPreview={false}
      mixedContentMode="never"
      // Android scales WebView text by the system font size; the page lays itself out.
      textZoom={100}
      scrollEnabled={false}
      bounces={false}
      showsVerticalScrollIndicator={false}
      showsHorizontalScrollIndicator={false}
      onMessage={onMessage}
      onError={onFailed}
      onHttpError={onFailed}
      onContentProcessDidTerminate={restart}
      onRenderProcessGone={restart}
    />
  )
})

const styles = StyleSheet.create({
  inline: { width: '100%', backgroundColor: 'transparent' },
  fullscreen: { flex: 1, backgroundColor: 'transparent' }
})
