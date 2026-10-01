import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/unused-test-path' } }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    symlinkSync: vi.fn(actual.symlinkSync)
  }
})
import { provisionClaudeProfile } from './claude-profile-provisioning'

const roots: string[] = []
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'claude-profile-setup-'))
  roots.push(root)
  const userHome = join(root, 'user')
  const profileHome = join(root, 'profile')
  const source = join(userHome, '.claude')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(profileHome)
  const json = (file: string, value: unknown): void => fs.writeFileSync(file, JSON.stringify(value))
  const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'))
  return { root, userHome, profileHome, source, json, read }
}
afterEach(() => {
  vi.clearAllMocks()
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('dormant Claude profile provisioning', () => {
  it('links resources, keeps private directories and sees later global installs', () => {
    const f = fixture()
    for (const name of ['skills', 'plugins', 'agents', 'commands', 'output-styles']) {
      fs.mkdirSync(join(f.source, name))
    }
    fs.mkdirSync(join(f.profileHome, 'agents'))
    fs.writeFileSync(join(f.profileHome, 'agents/mine.md'), 'private')
    const report = provisionClaudeProfile(f)
    expect(report.surfaces.agents).toBe('user-owned')
    for (const name of ['skills', 'plugins', 'commands', 'output-styles']) {
      expect(fs.realpathSync(join(f.profileHome, name))).toBe(fs.realpathSync(join(f.source, name)))
    }
    fs.writeFileSync(join(f.source, 'skills/new.md'), 'new skill')
    expect(fs.readFileSync(join(f.profileHome, 'skills/new.md'), 'utf8')).toBe('new skill')
    expect(fs.readFileSync(join(f.profileHome, 'agents/mine.md'), 'utf8')).toBe('private')
  })
  it('shares future settings keys but excludes auth and hooks; profile edits survive reprovision', () => {
    const f = fixture()
    f.json(join(f.source, 'settings.json'), {
      futureFeature: true,
      model: 'a',
      hooks: { private: true },
      apiKeyHelper: 'secret',
      awsAuthRefresh: 'secret',
      awsCredentialExport: 'secret',
      forceLoginMethod: 'secret',
      forceLoginOrgUUID: 'secret',
      env: {
        ANTHROPIC_API_KEY: 'secret',
        ANTHROPIC_AUTH_TOKEN: 'secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'secret',
        NORMAL: 'yes'
      }
    })
    fs.writeFileSync(join(f.source, 'CLAUDE.md'), 'source')
    provisionClaudeProfile(f)
    expect(f.read(join(f.profileHome, 'settings.json'))).toEqual({
      futureFeature: true,
      model: 'a',
      env: { NORMAL: 'yes' }
    })
    f.json(join(f.profileHome, 'settings.json'), {
      futureFeature: true,
      model: 'private',
      env: { NORMAL: 'yes' }
    })
    fs.writeFileSync(join(f.profileHome, 'CLAUDE.md'), 'private instructions')
    f.json(join(f.source, 'settings.json'), { model: 'b', futureFeature: false })
    fs.writeFileSync(join(f.source, 'CLAUDE.md'), 'updated source')
    provisionClaudeProfile(f)
    expect(f.read(join(f.profileHome, 'settings.json'))).toMatchObject({
      model: 'private',
      futureFeature: false
    })
    expect(fs.readFileSync(join(f.profileHome, 'CLAUDE.md'), 'utf8')).toBe('private instructions')
  })
  it('requires existing state, merges MCP/theme/onboarding/trust without copying login fields or reading credentials', () => {
    const f = fixture()
    const credentials = [
      join(f.source, '.credentials.json'),
      join(f.profileHome, '.credentials.json')
    ]
    for (const file of credentials) {
      fs.writeFileSync(file, 'SYNTHETIC_CREDENTIAL_BYTES')
    }
    f.json(join(f.userHome, '.claude.json'), {
      mcpServers: { local: { command: 'example' } },
      theme: 'dark',
      oauthAccount: { email: 'source' },
      userID: 'source-id'
    })
    provisionClaudeProfile(f)
    expect(fs.existsSync(join(f.profileHome, '.claude.json'))).toBe(false)
    f.json(join(f.profileHome, '.claude.json'), {
      oauthAccount: { email: 'profile' },
      userID: 'profile-id',
      projects: { '/work': { allowedTools: ['Read'] } }
    })
    vi.mocked(fs.readFileSync).mockClear()
    provisionClaudeProfile({ ...f, trustKeys: ['/work'] })
    const reads = vi.mocked(fs.readFileSync).mock.calls.map(([file]) => String(file))
    expect(reads.some((file) => credentials.includes(file))).toBe(false)
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual({
      oauthAccount: { email: 'profile' },
      userID: 'profile-id',
      mcpServers: { local: { command: 'example' } },
      theme: 'dark',
      hasCompletedOnboarding: true,
      projects: { '/work': { allowedTools: ['Read'], hasTrustDialogAccepted: true } }
    })
    for (const file of credentials) {
      expect(fs.readFileSync(file, 'utf8')).toBe('SYNTHETIC_CREDENTIAL_BYTES')
    }
    expect(fs.readFileSync(join(f.profileHome, '.orca-profile.json'), 'utf8')).not.toContain(
      'SYNTHETIC_CREDENTIAL_BYTES'
    )
  })
  it('uses Windows junctions through platform injection (native Windows remains unverified)', () => {
    const f = fixture()
    fs.mkdirSync(join(f.source, 'skills'))
    provisionClaudeProfile({ ...f, platform: 'win32' })
    expect(fs.symlinkSync).toHaveBeenCalledWith(
      fs.realpathSync(join(f.source, 'skills')),
      join(f.profileHome, 'skills'),
      'junction'
    )
  })
  it('refuses default-home aliases and leaves malformed profile state unchanged', () => {
    const f = fixture()
    expect(() => provisionClaudeProfile({ ...f, profileHome: f.source })).toThrow()
    fs.writeFileSync(join(f.profileHome, '.claude.json'), '{bad')
    expect(provisionClaudeProfile(f).warnings['.claude.json']).toBeDefined()
    expect(fs.readFileSync(join(f.profileHome, '.claude.json'), 'utf8')).toBe('{bad')
  })
})
