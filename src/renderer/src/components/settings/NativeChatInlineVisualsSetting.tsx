import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SettingsSwitchRow } from './SettingsFormControls'

type NativeChatInlineVisualsSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function NativeChatInlineVisualsSetting({
  settings,
  updateSettings
}: NativeChatInlineVisualsSettingProps): React.JSX.Element {
  const enabled = settings.nativeChatInlineVisuals !== false
  return (
    <SettingsSwitchRow
      label={translate('components.settings.nativeChat.inlineVisualsTitle', 'Inline visuals')}
      description={translate(
        'components.settings.nativeChat.inlineVisualsCopy',
        'Let the agent show charts, diagrams and mockups inside its replies. Applies to newly started chats.'
      )}
      checked={enabled}
      ariaLabel={translate(
        'components.settings.nativeChat.inlineVisualsToggleLabel',
        'Toggle inline visuals'
      )}
      onChange={() => updateSettings({ nativeChatInlineVisuals: !enabled })}
    />
  )
}
