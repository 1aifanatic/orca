import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import {
  agentPermissionModes,
  isAgentPermissionMode,
  type AgentPermissionMode
} from '../../../../shared/tui-agent-permissions'
import { AGENT_CHAT_PERMISSION_MODES } from '../../../../shared/agent-chat-permission-mode'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { NativeChatPermissionModeName } from '../native-chat/NativeChatPermissionModePicker'
import {
  nativeChatPermissionModeLabel,
  nativeChatPermissionModeDescription
} from '../native-chat/native-chat-permission-mode-labels'
import type { AgentPermissionException } from './agent-permission-exceptions'

function exceptionReasonText(exception: AgentPermissionException): string {
  const mode = nativeChatPermissionModeLabel(exception.mode)
  const { reason } = exception
  if (reason.kind === 'unsupported-mode') {
    return translate(
      'components.settings.AgentsPane.agentPermissionsUnsupportedReason',
      'runs {{value0}}: this agent does not support the default mode.',
      { value0: mode }
    )
  }
  if (reason.kind === 'arguments') {
    return translate(
      'auto.components.settings.AgentsPane.agentPermissionsArgumentsReason',
      'runs {{value0}}: its Arguments set {{value1}}.',
      { value0: mode, value1: reason.options.join(' ') }
    )
  }
  if (reason.kind === 'environment') {
    return translate(
      'auto.components.settings.AgentsPane.agentPermissionsEnvironmentReason',
      'runs {{value0}}: its environment sets {{value1}}.',
      { value0: mode, value1: reason.options.join(' ') }
    )
  }
  return translate(
    'auto.components.settings.AgentsPane.agentPermissionsOwnSettingReason',
    'runs {{value0}}: it has its own setting.',
    { value0: mode }
  )
}

export function AgentPermissionsSetting({
  mode,
  exceptions,
  onChange,
  onRevealException
}: {
  mode: AgentPermissionMode
  exceptions: readonly AgentPermissionException[]
  onChange: (mode: AgentPermissionMode) => void
  onRevealException: (exception: AgentPermissionException) => void
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.AgentsPane.agentPermissions',
          'Agent Permissions'
        )}
        description={
          <>
            {translate(
              'auto.components.settings.AgentsPane.agentPermissionsDescription',
              'Default permissions for new chats and agent terminals.'
            )}{' '}
            {translate(
              'auto.components.settings.AgentsPane.agentPermissionsAppliesToAll',
              'Applies to every agent without its own setting in the list below.'
            )}
            {exceptions.length > 0 ? (
              <span className="mt-1 block">
                {translate(
                  'auto.components.settings.AgentsPane.agentPermissionsNotFollowing',
                  "These agents don't follow this default:"
                )}
                {exceptions.map((exception) => (
                  <span key={exception.agentId} className="block">
                    {exception.target ? (
                      <Button
                        type="button"
                        variant="link"
                        size="inline"
                        onClick={() => onRevealException(exception)}
                      >
                        {exception.label}
                      </Button>
                    ) : (
                      // Plain text until detection finishes and the row it would open exists.
                      exception.label
                    )}{' '}
                    {exceptionReasonText(exception)}
                  </span>
                ))}
              </span>
            ) : null}
          </>
        }
        action={
          <PermissionModeSelect
            value={mode}
            onChange={(choice) => {
              if (choice !== 'default') {
                onChange(choice)
              }
            }}
            ariaLabel={translate(
              'auto.components.settings.AgentsPane.agentPermissions',
              'Agent Permissions'
            )}
            modes={AGENT_CHAT_PERMISSION_MODES}
          />
        }
      />
    </section>
  )
}

type AgentPermissionChoice = AgentPermissionMode | 'default'

function PermissionModeSelect({
  value,
  modes,
  defaultMode,
  ariaLabel,
  onChange
}: {
  value: AgentPermissionChoice
  modes: readonly AgentPermissionMode[]
  defaultMode?: AgentPermissionMode
  ariaLabel: string
  onChange: (choice: AgentPermissionChoice) => void
}): React.JSX.Element {
  const defaultLabel = translate(
    'auto.components.settings.AgentsPane.agentPermissionOverrideDefault',
    'Default ({{value0}})',
    { value0: nativeChatPermissionModeLabel(defaultMode ?? 'ask') }
  )
  return (
    <Select
      value={value}
      onValueChange={(choice) => {
        if (choice !== value && (choice === 'default' || isAgentPermissionMode(choice))) {
          onChange(choice)
        }
      }}
    >
      <SelectTrigger size="sm" aria-label={ariaLabel}>
        <SelectValue>
          {value === 'default' ? defaultLabel : <NativeChatPermissionModeName mode={value} />}
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="end" className="w-72">
        {defaultMode ? <SelectItem value="default">{defaultLabel}</SelectItem> : null}
        {modes.map((mode) => (
          <SelectItem key={mode} value={mode} textValue={nativeChatPermissionModeLabel(mode)}>
            <div className="space-y-0.5">
              <NativeChatPermissionModeName mode={mode} />
              <div className="text-xs text-muted-foreground">
                {nativeChatPermissionModeDescription(mode)}
              </div>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** One agent's own permission choice; Default follows the shared setting. */
export function AgentPermissionOverrideControl({
  agentId,
  agentLabel,
  override,
  defaultMode,
  onChange
}: {
  agentId: TuiAgent
  agentLabel: string
  override: AgentPermissionMode | undefined
  defaultMode: AgentPermissionMode
  onChange: (choice: AgentPermissionChoice) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="text-xs text-muted-foreground">
        {translate('auto.components.settings.AgentsPane.agentPermissionOverride', 'Permissions')}
      </span>
      <PermissionModeSelect
        value={override ?? 'default'}
        onChange={onChange}
        ariaLabel={translate(
          'auto.components.settings.AgentsPane.agentPermissionOverrideAria',
          '{{value0}} permissions',
          { value0: agentLabel }
        )}
        modes={agentPermissionModes(agentId)}
        defaultMode={defaultMode}
      />
    </div>
  )
}
