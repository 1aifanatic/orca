// How each ACP agent loads the chat-visuals skill for one launch, without touching the user's own
// config: ACP itself has no way to hand an agent a skill.

import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { isStableCliVersionFrom } from '../agent-cli-version-probe'
import type { NativeChatVisualsSkillLocation } from '../native-chat/native-chat-visuals-skill-location'
import { writePluginFileAtomically } from '../plugins/plugin-atomic-file-write'

export type AcpVisualsSkillInput = {
  skill: NativeChatVisualsSkillLocation
  /** The `--version` the launch's binary printed; null when it printed none. */
  version: string | null
  /** What the child will see: its inherited environment with the launch's laid over it. */
  env: Readonly<Record<string, string>>
  /** The launch's working directory. */
  cwd: string
  /** An Orca-owned folder for config files an agent can only take by path. */
  configDirectory: string
}

/** What a launch adds so the agent finds the skill: a plugin folder the agent's args name, and/or
 *  variables laid over its environment. */
export type AcpVisualsSkillLaunch = {
  pluginDir?: string
  env?: Record<string, string>
}

/** Null: this launch can't load the skill, so the chat starts without visuals. */
export type AcpVisualsSkillLoader = (
  input: AcpVisualsSkillInput
) => Promise<AcpVisualsSkillLaunch | null>

// Why 1.0.44: the oldest release checked that has `agent --plugin-dir`; an unknown flag stops Grok.
const GROK_PLUGIN_DIR_FIRST_VERSION = '1.0.44'

/** Grok takes Claude's plugin layout through `agent --plugin-dir`, for this process only. */
export const loadGrokVisualsSkill: AcpVisualsSkillLoader = async ({ skill, version }) =>
  version !== null && isStableCliVersionFrom(version, GROK_PLUGIN_DIR_FIRST_VERSION)
    ? { pluginDir: skill.pluginDir }
    : null

/** `content` (the user's own inline config, if any) with `skillsRoot` added to its skill paths;
 *  null when that config is not one this can extend safely. */
export function withOpenCodeSkillsPath(
  content: string | undefined,
  skillsRoot: string
): string | null {
  let config: unknown
  try {
    config = content?.trim() ? JSON.parse(content) : {}
  } catch {
    // JSONC or a typo: rewriting it would drop the user's settings.
    return null
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return null
  }
  const skills: unknown = 'skills' in config ? config.skills : undefined
  // 2.x also takes a bare list of paths and URLs.
  if (Array.isArray(skills)) {
    return JSON.stringify({ ...config, skills: [...skills, skillsRoot] })
  }
  if (skills === undefined) {
    return JSON.stringify({ ...config, skills: { paths: [skillsRoot] } })
  }
  if (typeof skills !== 'object' || skills === null) {
    return null
  }
  const paths: unknown = 'paths' in skills ? skills.paths : []
  return Array.isArray(paths)
    ? JSON.stringify({ ...config, skills: { ...skills, paths: [...paths, skillsRoot] } })
    : null
}

// Why 2.x: 2.x adds inline `skills.paths` to the config files' list; 1.x lets it replace the
// user's own, so their skills would vanish from Orca's chats.
const OPENCODE_MERGED_SKILL_PATHS_FIRST_VERSION = '2.0.14'

/** OpenCode reads `skills.paths` from the inline config variable. */
export const loadOpenCodeVisualsSkill: AcpVisualsSkillLoader = async ({ skill, env, version }) => {
  if (
    version === null ||
    !isStableCliVersionFrom(version, OPENCODE_MERGED_SKILL_PATHS_FIRST_VERSION)
  ) {
    return null
  }
  const content = withOpenCodeSkillsPath(env.OPENCODE_CONFIG_CONTENT, skill.skillsRoot)
  return content === null ? null : { env: { OPENCODE_CONFIG_CONTENT: content } }
}

const OMP_CONFIG_FILE_NAMES = ['config.yml', 'config.yaml']

/** A config file's `skills.customDirectories`: undefined when the file or the key is absent, null
 *  when the file can't be read the way OMP would. */
async function ompCustomDirectoriesIn(path: string): Promise<unknown[] | undefined | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return isDefinitiveAbsence(error) ? undefined : null
  }
  const document = parseDocument(text)
  if (document.errors.length > 0) {
    return null
  }
  const config: unknown = document.toJS()
  if (config === null || config === undefined) {
    return undefined
  }
  if (typeof config !== 'object' || Array.isArray(config)) {
    return null
  }
  const skills: unknown = 'skills' in config ? config.skills : undefined
  if (skills === undefined || skills === null) {
    return undefined
  }
  if (typeof skills !== 'object' || Array.isArray(skills)) {
    return null
  }
  const directories: unknown = 'customDirectories' in skills ? skills.customDirectories : undefined
  return directories === undefined ? undefined : Array.isArray(directories) ? directories : null
}

/** The `skills.customDirectories` OMP uses without Orca's overlay, which replaces that list: the
 *  last of the user's overlays naming it, else the agent directory's config. Null when unknown. */
async function ompUserSkillDirectories(
  env: Readonly<Record<string, string>>,
  cwd: string
): Promise<unknown[] | null> {
  const home = env.HOME ?? homedir()
  const expand = (path: string) =>
    resolve(cwd, path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path)
  const overlays = (env.PI_CONFIG_FILES ?? '').split(delimiter).filter(Boolean).map(expand)
  for (const overlay of overlays.toReversed()) {
    const directories = await ompCustomDirectoriesIn(overlay)
    if (directories !== undefined) {
      return directories
    }
  }
  const agentDirectory = env.PI_CODING_AGENT_DIR
    ? expand(env.PI_CODING_AGENT_DIR)
    : join(home, '.omp', 'agent')
  for (const name of OMP_CONFIG_FILE_NAMES) {
    const directories = await ompCustomDirectoriesIn(join(agentDirectory, name))
    if (directories !== undefined) {
      return directories
    }
  }
  return []
}

/** OMP reads extra config files named in `PI_CONFIG_FILES`; this one adds the skill folder to the
 *  user's own. A named file that is missing stops OMP, so it is written before the launch names it.
 *  Named by its contents, so concurrent launches never rewrite one another's. */
export const loadOmpVisualsSkill: AcpVisualsSkillLoader = async ({
  skill,
  env,
  cwd,
  configDirectory
}) => {
  const own = await ompUserSkillDirectories(env, cwd)
  if (own === null) {
    return null
  }
  // JSON is YAML.
  const contents = `${JSON.stringify({ skills: { customDirectories: [...own, skill.skillsRoot] } })}\n`
  const overlay = join(
    configDirectory,
    `omp-visuals-skill-${createHash('sha256').update(contents, 'utf8').digest('hex').slice(0, 16)}.yml`
  )
  await mkdir(configDirectory, { recursive: true, mode: 0o700 })
  if ((await readFile(overlay, 'utf8').catch(() => null)) !== contents) {
    await writePluginFileAtomically(overlay, contents, { mode: 0o600 })
  }
  const files = [env.PI_CONFIG_FILES, overlay].filter(Boolean).join(delimiter)
  return { env: { PI_CONFIG_FILES: files } }
}
