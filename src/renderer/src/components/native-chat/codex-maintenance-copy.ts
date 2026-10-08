import { translate } from '@/i18n/i18n'
import type { CodexCliInstallation } from '../../../../shared/codex-cli-installation'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import type { CodexMaintenanceAction } from '../../../../shared/codex-cli-maintenance'

export function codexMaintenanceCommandText(
  action: CodexMaintenanceAction,
  minimum: string
): string {
  return action.manual
    ? translate(
        'codex.maintenance.manualUpdate',
        'Install Codex {{minimum}} or newer at {{path}}, then retry.',
        { path: action.installationPath ?? action.command, minimum }
      )
    : translate('codex.maintenance.runCommand', 'Run {{command}}.', { command: action.command })
}

export function codexMaintenanceLabel(update: boolean, busy = false): string {
  return busy
    ? update
      ? translate('codex.maintenance.updating', 'Updating…')
      : translate('codex.maintenance.installing', 'Installing…')
    : update
      ? translate('codex.maintenance.update', 'Update Codex')
      : translate('codex.maintenance.install', 'Install Codex')
}

export function codexMaintenanceTitle(installation: CodexCliInstallation): string {
  return installation.status === 'missing'
    ? translate('codex.maintenance.missingTitle', 'Codex not installed')
    : translate('codex.maintenance.unsupportedTitle', 'Codex update required')
}

export function codexMaintenanceReason(installation: CodexCliInstallation): string {
  return sayAgentSessionFailureTranslated(
    installation.status === 'missing' ? 'codexCliMissing' : 'codexCliTooOld',
    { installedVersion: installation.version ?? '', minimumVersion: installation.minimumVersion }
  )
}

export function codexMaintenanceSettingsStatus(installation: CodexCliInstallation): string | null {
  return installation.status === 'missing' || installation.status === 'unsupported'
    ? codexMaintenanceReason(installation)
    : null
}
