import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

export function AlwaysForceDeleteWorkspacesSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const title = translate('workspaceDeletion.settingTitle', 'Always Force Delete Workspaces')
  const description = translate(
    'workspaceDeletion.settingDescription',
    'Discard uncommitted changes and delete even when terminal shutdown cannot be verified. Archive hook failures and locked worktrees still require attention.'
  )
  return (
    <div id="general-always-force-delete-workspaces" className="scroll-mt-6">
      <SearchableSetting
        title={title}
        description={description}
        keywords={['delete', 'force', 'worktree', 'workspace', 'always', 'changes', 'terminal']}
      >
        <SettingsSwitchRow
          label={title}
          description={description}
          checked={settings.alwaysForceDeleteWorktrees === true}
          onChange={() =>
            updateSettings({
              alwaysForceDeleteWorktrees: settings.alwaysForceDeleteWorktrees !== true
            })
          }
        />
      </SearchableSetting>
    </div>
  )
}
