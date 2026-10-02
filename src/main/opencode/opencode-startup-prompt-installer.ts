import { OpenCodeHookService } from './hook-service'
import { OPENCODE_STARTUP_PROMPT_PLUGIN_DIRECTORY } from '../../shared/opencode-startup-prompt-install'

export function createOpenCodeStartupPromptInstaller(source: () => string): OpenCodeHookService {
  return new OpenCodeHookService({
    pluginFileName: `${OPENCODE_STARTUP_PROMPT_PLUGIN_DIRECTORY}.js`,
    legacyHooksDir: 'opencode-startup-prompt-hooks',
    overlayDir: 'opencode-startup-prompt-overlays',
    pluginSource: source,
    tuiOnlyDirectory: OPENCODE_STARTUP_PROMPT_PLUGIN_DIRECTORY
  })
}
