import { describe, expect, it } from 'vitest'
import {
  buildNativeChatVisualDocument,
  NATIVE_CHAT_VISUAL_CSP,
  nativeChatVisualOpenableUrl,
  nativeChatVisualThemeMessage,
  parseNativeChatVisualFrameMessage,
  type NativeChatVisualTheme
} from './native-chat-visual-document'

const THEME: NativeChatVisualTheme = {
  colorScheme: 'dark',
  variables: { '--background': '#111111', '--chart-1': 'oklch(80.9% 0.105 251.813)' }
}

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split(';').map((part) => {
      const [name = '', ...values] = part.trim().split(/\s+/)
      return [name, values.join(' ')]
    })
  )
}

describe('NATIVE_CHAT_VISUAL_CSP', () => {
  it('closes every request class except CDN scripts, styles, fonts and images', () => {
    const policy = directives(NATIVE_CHAT_VISUAL_CSP)
    expect(policy.get('default-src')).toBe("'none'")
    for (const closed of [
      'connect-src',
      'frame-src',
      'child-src',
      'worker-src',
      'object-src',
      'media-src',
      'form-action',
      'base-uri'
    ]) {
      expect(policy.get(closed), closed).toBe("'none'")
    }
    expect(policy.get('script-src')).toContain('https://cdn.jsdelivr.net')
    expect(policy.get('script-src')).not.toContain('unsafe-eval')
    expect(policy.get('img-src')).not.toMatch(/https:(\s|$)|\*/)
  })
})

describe('buildNativeChatVisualDocument', () => {
  it('puts the policy before anything the author wrote and before any script', () => {
    const document = buildNativeChatVisualDocument('<script>evil()</script>', THEME)
    const policyAt = document.indexOf('http-equiv="Content-Security-Policy"')
    expect(policyAt).toBeGreaterThan(0)
    expect(policyAt).toBeLessThan(document.indexOf('<script>'))
    expect(document.endsWith('<script>evil()</script>')).toBe(true)
  })

  it('sets the theme variables before content, dropping values that could escape the style', () => {
    const document = buildNativeChatVisualDocument('', {
      colorScheme: 'dark',
      variables: {
        '--background': '#111111',
        '--foreground': 'red}</style><script>alert(1)</script>',
        '--border': 'red; background: url(https://x)'
      }
    })
    expect(document).toContain(':root{color-scheme:dark;--background:#111111}')
    expect(document).not.toContain('alert(1)')
    expect(document).not.toContain('url(https://x)')
  })

  it('keeps theme variables to the published list', () => {
    const theme = {
      colorScheme: 'light' as const,
      variables: { '--background': '#fff', '--secret': 'x' }
    }
    expect(nativeChatVisualThemeMessage(theme)).toEqual({
      type: 'orca-visual:theme',
      colorScheme: 'light',
      variables: { '--background': '#fff' }
    })
  })
})

describe('parseNativeChatVisualFrameMessage', () => {
  it('clamps heights to the frame bounds and refuses non-finite ones', () => {
    expect(parseNativeChatVisualFrameMessage({ type: 'orca-visual:height', height: 10 })).toEqual({
      kind: 'height',
      height: 80
    })
    expect(parseNativeChatVisualFrameMessage({ type: 'orca-visual:height', height: 5e9 })).toEqual({
      kind: 'height',
      height: 2000
    })
    expect(
      parseNativeChatVisualFrameMessage({ type: 'orca-visual:height', height: Number.NaN })
    ).toBeNull()
  })

  it('accepts only http(s) links without credentials', () => {
    expect(nativeChatVisualOpenableUrl('https://example.com')).toBe('https://example.com/')
    expect(nativeChatVisualOpenableUrl('http://example.com/x')).toBe('http://example.com/x')
    expect(nativeChatVisualOpenableUrl('javascript:alert(1)')).toBeNull()
    expect(nativeChatVisualOpenableUrl('https://a:b@example.com')).toBeNull()
    expect(nativeChatVisualOpenableUrl('/relative')).toBeNull()
  })

  it('ignores anything that is not one of the two requests', () => {
    for (const data of [null, 'height', { type: 'orca-visual:theme' }, { height: 100 }, []]) {
      expect(parseNativeChatVisualFrameMessage(data)).toBeNull()
    }
  })
})
