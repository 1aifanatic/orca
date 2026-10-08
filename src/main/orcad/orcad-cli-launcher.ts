import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ORCAD_CLI_ENTRY_FILENAME, orcadCliLauncherFilename } from '../../shared/orcad-artifacts'
import { resolveOrcadInstallRoot } from './orcad-app-paths'

export function resolveOrcadCliLauncher(directory = resolveOrcadInstallRoot()): string | null {
  const launcher = join(directory, orcadCliLauncherFilename(process.platform))
  return existsSync(join(directory, ORCAD_CLI_ENTRY_FILENAME)) && existsSync(launcher)
    ? launcher
    : null
}
