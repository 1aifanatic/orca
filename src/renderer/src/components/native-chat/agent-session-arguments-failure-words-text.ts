// Desktop words for a saved Arguments refusal, one piece each of the shared sentence.

import { translate } from '@/i18n/i18n'
import {
  AGENT_SESSION_FAILURE_COPY as COPY,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureCopyValues
} from '../../../../shared/agent-session-failure-copy'

type SavedArgumentsCopyId = Extract<
  AgentSessionFailureCopyId,
  `arguments${string}` | 'removeFromSavedArguments' | 'editSavedArguments'
>

export const SAVED_ARGUMENTS_PIECES: Record<
  SavedArgumentsCopyId,
  (values: AgentSessionFailureCopyValues) => string
> = {
  argumentsUnsupportedOption: (values) =>
    translate(
      'components.native-chat.failureWords.argumentsUnsupportedOption',
      COPY.argumentsUnsupportedOption,
      values
    ),
  argumentsUnnamedOption: (values) =>
    translate(
      'components.native-chat.failureWords.argumentsUnnamedOption',
      COPY.argumentsUnnamedOption,
      values
    ),
  argumentsMissingValue: (values) =>
    translate(
      'components.native-chat.failureWords.argumentsMissingValue',
      COPY.argumentsMissingValue,
      values
    ),
  argumentsMultipleValues: (values) =>
    translate(
      'components.native-chat.failureWords.argumentsMultipleValues',
      COPY.argumentsMultipleValues,
      values
    ),
  argumentsPositionalPrompt: () =>
    translate(
      'components.native-chat.failureWords.argumentsPositionalPrompt',
      COPY.argumentsPositionalPrompt
    ),
  argumentsUnclosedQuote: () =>
    translate(
      'components.native-chat.failureWords.argumentsUnclosedQuote',
      COPY.argumentsUnclosedQuote
    ),
  argumentsProfileHint: () =>
    translate(
      'components.native-chat.failureWords.argumentsProfileHint',
      COPY.argumentsProfileHint
    ),
  argumentsProviderHint: () =>
    translate(
      'components.native-chat.failureWords.argumentsProviderHint',
      COPY.argumentsProviderHint
    ),
  argumentsWorkspaceHint: () =>
    translate(
      'components.native-chat.failureWords.argumentsWorkspaceHint',
      COPY.argumentsWorkspaceHint
    ),
  argumentsImageHint: () =>
    translate('components.native-chat.failureWords.argumentsImageHint', COPY.argumentsImageHint),
  removeFromSavedArguments: (values) =>
    translate(
      'components.native-chat.failureWords.removeFromSavedArguments',
      COPY.removeFromSavedArguments,
      values
    ),
  editSavedArguments: (values) =>
    translate(
      'components.native-chat.failureWords.editSavedArguments',
      COPY.editSavedArguments,
      values
    )
}
