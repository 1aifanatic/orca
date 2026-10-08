import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadGrokVisualsSkill,
  loadOmpVisualsSkill,
  loadOpenCodeVisualsSkill,
  withOpenCodeSkillsPath,
  type AcpVisualsSkillInput
} from './acp-visuals-skill'

const SKILL = { pluginDir: '/app/plugin', skillsRoot: '/app/plugin/skills' }

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function input(overrides: Partial<AcpVisualsSkillInput> = {}): AcpVisualsSkillInput {
  return {
    skill: SKILL,
    version: null,
    env: {},
    cwd: '/repo',
    configDirectory: '/unused',
    ...overrides
  }
}

describe('Grok visuals skill', () => {
  it('names the plugin folder only on a release known to take --plugin-dir', async () => {
    await expect(loadGrokVisualsSkill(input({ version: '1.0.46' }))).resolves.toEqual({
      pluginDir: '/app/plugin'
    })
    await expect(loadGrokVisualsSkill(input({ version: '1.0.44' }))).resolves.toEqual({
      pluginDir: '/app/plugin'
    })
    await expect(loadGrokVisualsSkill(input({ version: '1.0.43' }))).resolves.toBeNull()
    await expect(loadGrokVisualsSkill(input({ version: null }))).resolves.toBeNull()
  })
})

describe('OpenCode visuals skill', () => {
  it('adds the skills root as the only inline config when the user has none', async () => {
    await expect(loadOpenCodeVisualsSkill(input({ version: '2.0.14' }))).resolves.toEqual({
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths: [SKILL.skillsRoot] } }) }
    })
  })

  it("keeps the user's own inline config and skill paths", () => {
    const merged = withOpenCodeSkillsPath(
      JSON.stringify({ model: 'm', skills: { paths: ['/mine'], urls: ['https://x'] } }),
      SKILL.skillsRoot
    )
    expect(JSON.parse(merged!)).toEqual({
      model: 'm',
      skills: { paths: ['/mine', SKILL.skillsRoot], urls: ['https://x'] }
    })
    expect(
      JSON.parse(withOpenCodeSkillsPath(JSON.stringify({ skills: ['/mine'] }), SKILL.skillsRoot)!)
    ).toEqual({ skills: ['/mine', SKILL.skillsRoot] })
  })

  it('leaves a config it cannot extend safely alone', async () => {
    for (const content of ['{ // jsonc\n}', '[]', '{"skills": 3}', '{"skills": {"paths": "/x"}}']) {
      expect(withOpenCodeSkillsPath(content, SKILL.skillsRoot)).toBeNull()
    }
    await expect(
      loadOpenCodeVisualsSkill(
        input({ version: '2.0.14', env: { OPENCODE_CONFIG_CONTENT: 'not json' } })
      )
    ).resolves.toBeNull()
  })

  it("skips 1.x, where the inline list would replace the user's own skill paths", async () => {
    await expect(loadOpenCodeVisualsSkill(input({ version: '1.18.31' }))).resolves.toBeNull()
    await expect(loadOpenCodeVisualsSkill(input({ version: null }))).resolves.toBeNull()
  })
})

describe('OMP visuals skill', () => {
  function scratchDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'acp-visuals-'))
    scratch.push(dir)
    return dir
  }
  async function loadOmp(env: Record<string, string>, root = scratchDir()) {
    const configDirectory = join(root, 'agent-config')
    const loaded = await loadOmpVisualsSkill(input({ configDirectory, env, cwd: root }))
    const overlays = readdirSync(configDirectory, { withFileTypes: true }).map((entry) =>
      join(configDirectory, entry.name)
    )
    return { loaded, overlays, root }
  }

  it("writes an overlay naming the skills root and appends it to the user's own overlays", async () => {
    const { loaded, overlays } = await loadOmp({ PI_CONFIG_FILES: '/user/overlay.yml' })
    expect(overlays).toHaveLength(1)
    expect(loaded).toEqual({
      env: { PI_CONFIG_FILES: `/user/overlay.yml${delimiter}${overlays[0]}` }
    })
    expect(JSON.parse(readFileSync(overlays[0], 'utf8'))).toEqual({
      skills: { customDirectories: [SKILL.skillsRoot] }
    })
    if (process.platform !== 'win32') {
      expect(statSync(overlays[0]).mode & 0o777).toBe(0o600)
    }
  })

  it("keeps the user's own skill folders, which the overlay's list replaces", async () => {
    const root = scratchDir()
    const agent = join(root, 'agent')
    mkdirSync(agent)
    writeFileSync(join(agent, 'config.yml'), 'skills:\n  customDirectories:\n    - ~/my-skills\n')
    const fromAgent = await loadOmp({ PI_CODING_AGENT_DIR: agent }, root)
    expect(JSON.parse(readFileSync(fromAgent.overlays[0], 'utf8'))).toEqual({
      skills: { customDirectories: ['~/my-skills', SKILL.skillsRoot] }
    })
  })

  it("takes the user's last overlay naming skill folders over the agent directory's config", async () => {
    const root = scratchDir()
    writeFileSync(join(root, 'config.yml'), 'skills:\n  customDirectories: [/agent-skills]\n')
    // Relative to the launch's working directory, as OMP reads it.
    writeFileSync(join(root, 'mine.yml'), 'skills:\n  customDirectories: [/team-skills]\n')
    writeFileSync(join(root, 'later.yml'), 'model: fast\n')
    const { loaded, overlays } = await loadOmp(
      { PI_CODING_AGENT_DIR: root, PI_CONFIG_FILES: ['mine.yml', 'later.yml'].join(delimiter) },
      root
    )
    expect(JSON.parse(readFileSync(overlays[0], 'utf8'))).toEqual({
      skills: { customDirectories: ['/team-skills', SKILL.skillsRoot] }
    })
    expect(loaded?.env?.PI_CONFIG_FILES).toBe(
      ['mine.yml', 'later.yml', overlays[0]].join(delimiter)
    )
  })

  it("starts without visuals when the user's config can't be read as OMP would", async () => {
    const root = scratchDir()
    writeFileSync(join(root, 'config.yml'), 'skills: [unclosed\n')
    await expect(
      loadOmpVisualsSkill(
        input({ configDirectory: join(root, 'agent-config'), env: { PI_CODING_AGENT_DIR: root } })
      )
    ).resolves.toBeNull()
  })
})
