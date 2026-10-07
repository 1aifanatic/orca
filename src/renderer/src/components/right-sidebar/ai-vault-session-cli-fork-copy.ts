import { translate } from '@/i18n/i18n'

/** Shared by the row menus and the details button, which offer the same fork. */
export function aiVaultResumeInNewCliTooltip(): string {
  return translate(
    'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewCliTooltip',
    'Forks this conversation into a new CLI session with its full history. The native chat stays as it is.'
  )
}
