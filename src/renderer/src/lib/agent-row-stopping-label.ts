import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { translate } from '@/i18n/i18n'
import type { AgentRowState } from './agent-row-decay-state'

/** "Stopping…" while a person's Stop ends a working row's turn, else null. Every agent row says it
 *  in place of the last tool line, which no longer says what comes next. */
export function agentRowStoppingLabel(
  entry: Pick<AgentStatusEntry, 'mainAgent'>,
  state: AgentRowState | null | undefined
): string | null {
  return state === 'working' && entry.mainAgent?.stopping
    ? translate('components.native-chat.status.stopping', 'Stopping…')
    : null
}
