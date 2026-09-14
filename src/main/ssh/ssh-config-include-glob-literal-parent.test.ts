import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getLiteralGlobParent } from './ssh-config-include-glob-readability'

/**
 * The directory an empty `globSync` result has to be checked against. Worth its own test because
 * `dirname` alone is wrong for half of these: it steps a level too far up on a pattern whose literal
 * part ends at a separator, which would silently check the wrong directory's permissions.
 */
describe('getLiteralGlobParent', () => {
  it.each([
    ['/home/u/.ssh/config.d/*', '/home/u/.ssh/config.d'],
    ['/home/u/.ssh/config.d/5*.conf', '/home/u/.ssh/config.d'],
    ['/home/u/.ssh/config.d/**/*.conf', '/home/u/.ssh/config.d'],
    ['/home/u/.ssh/conf?g', '/home/u/.ssh'],
    ['/home/u/.ssh/[ab]*', '/home/u/.ssh'],
    // No metacharacter at all: callers only reach this for globs, but it must not invent a parent.
    ['/home/u/.ssh/config', '/home/u/.ssh'],
    ['/*', '/']
  ])('resolves %s to %s', (pattern, expected) => {
    expect(getLiteralGlobParent(pattern, posix)).toBe(expected)
  })

  it('keeps backslash-separated patterns in the Windows path space', () => {
    expect(getLiteralGlobParent('C:\\Users\\u\\.ssh\\config.d\\*', win32)).toBe(
      'C:\\Users\\u\\.ssh\\config.d'
    )
    // Windows accepts forward slashes too, and ssh_config is routinely written with them.
    expect(getLiteralGlobParent('C:/Users/u/.ssh/config.d/*.conf', win32)).toBe(
      'C:/Users/u/.ssh/config.d'
    )
  })
})
