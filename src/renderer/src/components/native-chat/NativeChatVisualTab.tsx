import { useRef, useState } from 'react'
import { NativeChatVisualFrame } from './NativeChatVisualFrame'
import { NativeChatVisualUnavailable } from './NativeChatInlineVisual'
import type { OpenChatVisualTabState } from './native-chat-visual-tab'
import { useNativeChatVisualDocument } from './use-native-chat-visual-document'

/** A chat visual in its own tab: the same isolated frame as inline, filling the tab. */
export function NativeChatVisualTab({
  visual
}: {
  visual: OpenChatVisualTabState
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [retired, setRetired] = useState(false)
  const state = useNativeChatVisualDocument(
    { target: visual.target, sessionId: visual.sessionId, file: visual.file },
    true
  )

  if (retired || state.status === 'unavailable') {
    return (
      <div className="px-4">
        <NativeChatVisualUnavailable />
      </div>
    )
  }
  return (
    <div ref={boxRef} className="flex h-full min-h-0 flex-col">
      {state.status === 'ready' ? (
        <NativeChatVisualFrame
          document={state.document}
          title={visual.title ?? visual.file}
          layout="panel"
          themeScope={boxRef}
          onRetired={() => setRetired(true)}
        />
      ) : null}
    </div>
  )
}
