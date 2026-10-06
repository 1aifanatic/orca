import { NativeChatSessionGate } from './NativeChatSessionGate'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { NativeChatResolvedView } from './NativeChatResolvedView'
import { useNativeChatStatusEntry } from './use-native-chat-status-entry'
import type { NativeChatViewProps } from './native-chat-view-types'
import { NativeChatPaneFileDropSurface } from './NativeChatPaneFileDropSurface'
import { useLayoutEffect, useRef } from 'react'
import { forwardStructuredAgentSessionDraft } from './native-chat-composer-draft-forwarding'

export type { NativeChatViewProps } from './native-chat-view-types'

/** Resolves an agent terminal into its native conversation and composer UI. */
export default function NativeChatView(props: NativeChatViewProps): React.JSX.Element {
  useDraftFollowsReplacedConversation(props.mode === 'structured' ? props.sessionId : undefined)
  return (
    <NativeChatPaneFileDropSurface className="relative flex h-full min-h-0 min-w-0 w-full">
      {props.mode === 'structured' ? (
        <NativeChatStructuredSession key={props.sessionId} {...props} />
      ) : (
        <NativeChatBridgeView {...props} />
      )}
    </NativeChatPaneFileDropSurface>
  )
}

function NativeChatBridgeView({
  terminalTabId,
  isVisible,
  isFocusedGroup,
  paneKey: preferredPaneKey,
  targetPtyId = null,
  launchAgent,
  resolvedAgent,
  ownsTabWideLaunchDraft,
  onSwitchToTerminal,
  readTerminalScreen,
  contextMenuActions
}: Exclude<NativeChatViewProps, { mode: 'structured' }>): React.JSX.Element {
  const { entry: agentStatusEntry, paneKey } = useNativeChatStatusEntry(
    terminalTabId,
    preferredPaneKey
  )
  return (
    <NativeChatSessionGate
      paneKey={paneKey}
      launchAgent={launchAgent}
      resolvedAgent={resolvedAgent}
      agentStatusEntry={agentStatusEntry}
      ptyId={targetPtyId}
    >
      {(resolution) => (
        <NativeChatResolvedView
          paneKey={resolution.paneKey}
          agent={resolution.agent}
          sessionId={resolution.sessionId}
          transcriptPath={resolution.transcriptPath}
          isVisible={isVisible}
          isFocusedGroup={isFocusedGroup}
          targetPtyId={targetPtyId}
          terminalTabId={terminalTabId}
          ownsTabWideLaunchDraft={ownsTabWideLaunchDraft}
          onSwitchToTerminal={onSwitchToTerminal}
          readTerminalScreen={readTerminalScreen}
          contextMenuActions={contextMenuActions}
        />
      )}
    </NativeChatSessionGate>
  )
}

/** A pane's conversation changes under it only when a /clear replaces it: what was typed there
 *  goes along to the new conversation's composer. */
function useDraftFollowsReplacedConversation(sessionId: string | undefined): void {
  const previous = useRef(sessionId)
  useLayoutEffect(() => {
    const from = previous.current
    previous.current = sessionId
    if (from && sessionId && from !== sessionId) {
      forwardStructuredAgentSessionDraft(from, sessionId)
    }
  }, [sessionId])
}
