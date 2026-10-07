import { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'

export default function VideoViewer({
  src,
  filePath,
  canOpenLocally
}: {
  src: string
  filePath: string
  canOpenLocally: boolean
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)
  const [openFailed, setOpenFailed] = useState(false)
  useEffect(() => {
    const video = videoRef.current
    // Strict Mode replays cleanup while retaining the DOM element.
    if (video) {
      video.src = src
    }
    return () => {
      if (!video) {
        return
      }
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [src])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-orca-video-viewer>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {failed ? (
          <p className="text-sm text-muted-foreground" role="alert">
            {translate(
              'videoPreview.unavailable',
              'Unable to play this video. The file may be unavailable or use an unsupported codec.'
            )}
          </p>
        ) : (
          <video
            ref={videoRef}
            src={src}
            controls
            preload="metadata"
            aria-label={filePath.split(/[/\\]/).pop() || filePath}
            className="max-h-full max-w-full"
            onError={() => setFailed(true)}
          />
        )}
      </div>
      {canOpenLocally && (
        <div className="flex items-center justify-end gap-2 border-t px-3 py-2">
          {openFailed && (
            <p className="text-xs text-muted-foreground" role="alert">
              {translate('videoPreview.openFailed', 'Could not open this file in the default app.')}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                setOpenFailed(!(await window.api.shell.openFilePath(filePath)))
              } catch {
                setOpenFailed(true)
              }
            }}
          >
            {translate('videoPreview.openDefault', 'Open in Default App')}
          </Button>
        </div>
      )}
    </div>
  )
}
