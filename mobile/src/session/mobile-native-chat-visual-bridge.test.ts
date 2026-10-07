import { describe, expect, it } from 'vitest'
import { readMobileNativeChatVisualBridgeMessage } from './mobile-native-chat-visual-bridge'
import { buildMobileNativeChatVisualHostDocument } from './mobile-native-chat-visual-host-document'

const TOKEN = 'f'.repeat(32)

function frame(data: unknown, token: string = TOKEN): string {
  return JSON.stringify({ token, kind: 'frame', data })
}

describe('readMobileNativeChatVisualBridgeMessage', () => {
  it('accepts a clamped height and an http(s) link from the host document', () => {
    expect(
      readMobileNativeChatVisualBridgeMessage(
        frame({ type: 'orca-visual:height', height: 312.4 }),
        TOKEN
      )
    ).toEqual({ kind: 'height', height: 312 })
    expect(
      readMobileNativeChatVisualBridgeMessage(
        frame({ type: 'orca-visual:height', height: 99999 }),
        TOKEN
      )
    ).toEqual({ kind: 'height', height: 2000 })
    expect(
      readMobileNativeChatVisualBridgeMessage(
        frame({ type: 'orca-visual:open-link', url: 'https://example.com/a?b=c' }),
        TOKEN
      )
    ).toEqual({ kind: 'open-link', url: 'https://example.com/a?b=c' })
    expect(
      readMobileNativeChatVisualBridgeMessage(
        JSON.stringify({ token: TOKEN, kind: 'escaped' }),
        TOKEN
      )
    ).toEqual({ kind: 'escaped' })
  })

  it('drops a message without this frame token, however well-formed', () => {
    const height = { type: 'orca-visual:height', height: 300 }
    expect(readMobileNativeChatVisualBridgeMessage(frame(height, 'other'), TOKEN)).toBeNull()
    expect(
      readMobileNativeChatVisualBridgeMessage(
        JSON.stringify({ kind: 'frame', data: height }),
        TOKEN
      )
    ).toBeNull()
    expect(
      readMobileNativeChatVisualBridgeMessage(JSON.stringify({ kind: 'escaped' }), TOKEN)
    ).toBeNull()
  })

  it('drops links that are not plain http(s)', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'orca://open',
      'data:text/html,hi',
      'https://user:pass@example.com/',
      `https://example.com/${'a'.repeat(3000)}`,
      42
    ]) {
      expect(
        readMobileNativeChatVisualBridgeMessage(
          frame({ type: 'orca-visual:open-link', url }),
          TOKEN
        ),
        String(url)
      ).toBeNull()
    }
  })

  it('drops non-finite heights, unknown requests, junk and oversized messages', () => {
    for (const height of [Number.NaN, Number.POSITIVE_INFINITY, -1, '300', null]) {
      expect(
        readMobileNativeChatVisualBridgeMessage(
          frame({ type: 'orca-visual:height', height }),
          TOKEN
        ),
        String(height)
      ).toBeNull()
    }
    expect(
      readMobileNativeChatVisualBridgeMessage(frame({ type: 'orca-visual:navigate' }), TOKEN)
    ).toBeNull()
    expect(readMobileNativeChatVisualBridgeMessage('not json', TOKEN)).toBeNull()
    expect(
      readMobileNativeChatVisualBridgeMessage(
        frame({ type: 'orca-visual:height', height: 300, pad: 'x'.repeat(9000) }),
        TOKEN
      )
    ).toBeNull()
  })
})

describe('buildMobileNativeChatVisualHostDocument', () => {
  const build = (visualDocument: string) =>
    buildMobileNativeChatVisualHostDocument({
      visualDocument,
      token: TOKEN,
      title: 'Usage </script><script>alert(1)</script>',
      mode: 'inline'
    })

  it('puts the visual in an opaque frame that may only run scripts', () => {
    const document = build('<p>hi</p>')
    expect(document).toContain("frame.setAttribute('sandbox', 'allow-scripts')")
    expect(document).not.toMatch(/allow-same-origin|allow-popups|allow-top-navigation|allow-forms/)
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<script>'))
  })

  it('embeds the visual and title as script literals that cannot close the host script', () => {
    const document = build('</script><script>window.ReactNativeWebView.postMessage("x")</script>')
    // One script element: the host's own.
    expect(document.match(/<script>/g)).toHaveLength(1)
    expect(document.match(/<\/script>/g)).toHaveLength(1)
  })

  it('relays only messages from the child window, links only under user activation', () => {
    const document = build('<p>hi</p>')
    expect(document).toContain('event.source !== frame.contentWindow')
    expect(document).toContain('activation.isActive')
    expect(document).toContain(JSON.stringify(TOKEN))
  })
})
