import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Switch } from '../ui/switch'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow } from './SettingsFormControls'
import { automaticReviewRefreshSearchEntry } from './automatic-review-refresh-setting'

export function AutomaticReviewRefreshSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const { title, description, keywords } = automaticReviewRefreshSearchEntry()
  return (
    <SearchableSetting title={title} description={description} keywords={keywords}>
      <SettingsRow
        label={title}
        description={description}
        control={
          <Switch
            aria-label={title}
            checked={settings.automaticReviewRefresh !== false}
            onCheckedChange={(checked) => void updateSettings({ automaticReviewRefresh: checked })}
          />
        }
      />
    </SearchableSetting>
  )
}
