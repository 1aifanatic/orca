import { translate } from '@/i18n/i18n'
import type { CodexCliInstallation } from '../../../../shared/codex-cli-installation'

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
  return installation.status === 'missing'
    ? translate('codex.maintenance.missingReason', 'Install Codex before starting a chat.')
    : translate(
        'codex.maintenance.unsupportedReason',
        'Installed {{installed}}; version {{minimum}} or newer is required.',
        {
          installed: installation.version ?? '',
          minimum: installation.minimumVersion
        }
      )
}

export function codexMaintenanceSettingsStatus(installation: CodexCliInstallation): string | null {
  if (installation.status === 'missing') {
    return translate('codex.maintenance.notInstalled', 'Not installed')
  }
  return installation.status === 'unsupported'
    ? translate(
        'codex.maintenance.settingsRequired',
        'Update required (installed {{installed}}, needs {{minimum}})',
        {
          installed: installation.version ?? '',
          minimum: installation.minimumVersion
        }
      )
    : null
}
