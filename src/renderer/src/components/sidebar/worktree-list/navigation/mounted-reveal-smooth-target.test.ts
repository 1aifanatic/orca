// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMountedRevealSmoothTarget } from './mounted-reveal-smooth-target'

function fixture(scrollTop = 0, top = 10_000) {
  const container = document.createElement('div')
  const element = document.createElement('div')
  const geometry = { top, height: 55 }
  container.append(element)
  container.scrollTop = scrollTop
  Object.defineProperty(container, 'clientHeight', { value: 600 })
  container.getBoundingClientRect = () => new DOMRect(0, 100, 200, 600)
  element.getBoundingClientRect = () =>
    new DOMRect(0, 100 + geometry.top - container.scrollTop, 200, geometry.height)
  const scrollTo = vi.fn()
  container.scrollTo = scrollTo
  const markScroll = vi.fn()
  return { container, element, geometry, scrollTo, markScroll }
}

afterEach(() => vi.restoreAllMocks())

describe('measured smooth reveal destination', () => {
  it('accumulates distant measurement drift without repeatedly restarting native easing', () => {
    const f = fixture()
    const target = createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 20)!
    f.container.scrollTop = 1_000
    target.retarget(f.markScroll)
    for (const top of [9_000, 8_000, 7_000]) {
      f.geometry.top = top
      target.retarget(f.markScroll)
    }
    expect(f.scrollTo).not.toHaveBeenCalled()
    f.container.scrollTop = 5_000
    target.retarget(f.markScroll)
    expect(f.markScroll).toHaveBeenCalledExactlyOnceWith(6_455)
    expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 6_455, behavior: 'smooth' })
    target.retarget(f.markScroll)
    expect(f.scrollTo).toHaveBeenCalledOnce()
    expect(target.expiresAt).toBe(2_020)
  })

  it('retargets before one fast measurement frame can cross the viewport', () => {
    const f = fixture()
    const target = createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 0)!
    f.geometry.top = 7_000
    f.container.scrollTop = 3_500
    target.retarget(f.markScroll)
    expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 6_455, behavior: 'smooth' })
  })

  it('follows the end edge including height changes on a downward approach', () => {
    const f = fixture()
    const target = createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 0)!
    f.container.scrollTop = 8_000
    f.geometry.height = 155
    target.retarget(f.markScroll)
    expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 9_555, behavior: 'smooth' })
  })

  it('preserves the inset and start edge on an upward approach', () => {
    const f = fixture(10_000, 5_000)
    const target = createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 0)!
    f.container.scrollTop = 7_000
    f.geometry.top = 6_000
    f.geometry.height = 155
    target.retarget(f.markScroll)
    expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 5_966, behavior: 'smooth' })
  })

  it('does not retarget an unchanged destination or an already visible element', () => {
    const f = fixture()
    const target = createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 0)!
    f.container.scrollTop = 8_000
    target.retarget(f.markScroll)
    expect(f.scrollTo).not.toHaveBeenCalled()
    f.geometry.top = 8_100
    expect(createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 0)).toBeNull()
  })

  it.each(['auto', 'instant'] as const)('never animates a %s request', (behavior) => {
    const f = fixture()
    expect(createMountedRevealSmoothTarget(f.container, f.element, behavior, 0)).toBeNull()
  })

  it('honors reduced motion before creating an animated destination', () => {
    const f = fixture()
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
    expect(createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 0)).toBeNull()
  })

  it('stops at the current offset when a fast frame has already revealed the moved target', () => {
    const f = fixture()
    const target = createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 0)!
    f.geometry.top = 7_100
    f.container.scrollTop = 7_000
    target.retarget(f.markScroll)
    expect(f.markScroll).toHaveBeenCalledExactlyOnceWith(7_000)
    expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 7_000, behavior: 'auto' })
  })
})
