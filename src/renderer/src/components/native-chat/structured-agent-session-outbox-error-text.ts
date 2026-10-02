// The composer's own errors for the structured chat's outbox, in the reader's language.

import { translate } from '@/i18n/i18n'
import type { StructuredAgentSessionSendDispositionError } from '../../../../shared/structured-agent-session-send-disposition'

export function structuredAgentSessionOutboxSaveFailedText(): string {
  return translate(
    'components.native-chat.outbox.saveFailed',
    "Couldn't save your message. Try again."
  )
}

export function structuredAgentSessionSendDispositionErrorText(
  error: StructuredAgentSessionSendDispositionError
): string {
  switch (error) {
    case 'redeliveryRefused':
      return translate(
        'components.native-chat.outbox.redeliveryRefused',
        "Couldn't confirm your message was sent. Check the chat before sending it again."
      )
  }
}
