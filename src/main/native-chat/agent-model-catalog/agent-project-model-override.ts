import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  claudeSettingsMayPickModel,
  codexConfigMayPickModel
} from './agent-project-model-config-keys'

// A listing's default is the account's, but a chat runs in a workspace whose own
// config can pick another model. These checks only ask whether such config sets a
// model or effort key; they never use what it picks, so a hit means "name no default".

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** A `.git` file (linked worktree) or a `.git` directory with a HEAD marks a project root. */
async function isProjectRoot(dir: string): Promise<boolean> {
  const git = join(dir, '.git')
  try {
    const entry = await stat(git)
    return entry.isFile() || (await exists(join(git, 'HEAD')))
  } catch {
    return false
  }
}

/**
 * The directories a chat started in `cwd` reads project config from: each one
 * from the project root (the nearest ancestor holding `.git`, else `cwd`
 * itself) down to `cwd`.
 */
async function projectConfigDirectories(cwd: string): Promise<string[]> {
  const chain: string[] = []
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    chain.push(dir)
    if (await isProjectRoot(dir)) {
      return chain
    }
    if (dirname(dir) === dir) {
      return [resolve(cwd)]
    }
  }
}

type ProjectModelLayers = {
  folder: string
  files: string[]
  mayPickModel: (text: string) => boolean
}

// The project files each agent's CLI reads a model from, under its per-directory config folder.
const PROJECT_MODEL_LAYERS: Readonly<Record<string, ProjectModelLayers>> = {
  codex: { folder: '.codex', files: ['config.toml'], mayPickModel: codexConfigMayPickModel },
  claude: {
    folder: '.claude',
    files: ['settings.json', 'settings.local.json'],
    mayPickModel: claudeSettingsMayPickModel
  }
}

/** A missing file is no layer; one that exists but can't be read might pick anything. */
async function fileMayPickModel(path: string, layers: ProjectModelLayers): Promise<boolean> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : null
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
  return layers.mayPickModel(text)
}

/** The folder that is the agent's own home is account config, not a layer; any other with a
 *  config file setting a model or effort is one. */
async function directoryMayOverride(
  dir: string,
  layers: ProjectModelLayers,
  accountHomePath: string
): Promise<boolean> {
  const layer = join(dir, layers.folder)
  if (layer === resolve(accountHomePath)) {
    return false
  }
  const found = await Promise.all(
    layers.files.map((file) => fileMayPickModel(join(layer, file), layers))
  )
  return found.some(Boolean)
}

/** True when a new chat in `workspacePath` could run a model other than the listed default. */
export async function workspaceMayOverrideDefaultModel(input: {
  agent: string
  workspacePath: string
  accountHomePath: string
}): Promise<boolean> {
  // Grok reads its default model from user, managed and env config only, never a project's.
  if (input.agent === 'grok') {
    return false
  }
  // Every other agent's own settings may pick another model; Codex's and Claude's project layers are checked.
  const layers = PROJECT_MODEL_LAYERS[input.agent]
  if (!layers) {
    return true
  }
  const dirs = await projectConfigDirectories(input.workspacePath)
  const results = await Promise.all(
    dirs.map((dir) => directoryMayOverride(dir, layers, input.accountHomePath))
  )
  return results.some(Boolean)
}
