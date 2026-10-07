// @vitest-environment happy-dom

import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VideoViewer from './VideoViewer'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

describe('VideoViewer', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps its source through Strict Mode setup and stops playback on unmount', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <StrictMode>
          <VideoViewer src="orca-media://video/token" filePath="clip.mp4" canOpenLocally />
        </StrictMode>
      )
    )
    const video = container.querySelector('video')
    expect(video?.getAttribute('src')).toBe('orca-media://video/token')
    expect(video?.controls).toBe(true)
    expect(video?.autoplay).toBe(false)
    expect(video?.preload).toBe('metadata')
    pause.mockClear()
    load.mockClear()
    await act(async () => root.unmount())
    expect(pause).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)
    expect(video?.getAttribute('src')).toBeNull()
  })

  it('shows a persistent playback error and only offers the default app for local files', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <VideoViewer src="orca-media://video/token" filePath="remote.mp4" canOpenLocally={false} />
      )
    )
    await act(async () => container.querySelector('video')?.dispatchEvent(new Event('error')))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Unable to play this video'
    )
    expect(container.querySelector('button')).toBeNull()
    await act(async () => root.unmount())
  })
})
