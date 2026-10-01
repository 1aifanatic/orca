import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, linkSync: vi.fn(actual.linkSync), symlinkSync: vi.fn(actual.symlinkSync) }
})
import { shareClaudeProfileHistory } from './claude-profile-history'
const roots: string[] = []
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'claude-profile-history-'))
  roots.push(root)
  const profileHome = join(root, 'profile')
  const defaultHome = join(root, 'default')
  fs.mkdirSync(profileHome)
  fs.mkdirSync(defaultHome)
  return { profileHome, defaultHome }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('Claude profile history sharing', () => {
  it('merges session trees without overwriting conflicts and shares future default writes', () => {
    const f = fixture()
    for (const home of [f.profileHome, f.defaultHome]) {
      fs.mkdirSync(join(home, 'projects'))
    }
    fs.writeFileSync(join(f.profileHome, 'projects/session.jsonl'), 'new')
    fs.writeFileSync(join(f.profileHome, 'projects/conflict.jsonl'), 'private')
    fs.writeFileSync(join(f.defaultHome, 'projects/conflict.jsonl'), 'existing')
    shareClaudeProfileHistory(f)
    expect(fs.readFileSync(join(f.defaultHome, 'projects/session.jsonl'), 'utf8')).toBe('new')
    expect(fs.readFileSync(join(f.defaultHome, 'projects/conflict.jsonl'), 'utf8')).toBe('existing')
    expect(
      fs.readFileSync(join(f.profileHome, 'projects.orca-profile-merge/conflict.jsonl'), 'utf8')
    ).toBe('private')
    fs.writeFileSync(join(f.defaultHome, 'projects/later.jsonl'), 'later')
    expect(fs.readFileSync(join(f.profileHome, 'projects/later.jsonl'), 'utf8')).toBe('later')
  })
  it('recovers a directory swap interrupted before link publication', () => {
    const f = fixture()
    fs.mkdirSync(join(f.profileHome, 'projects.orca-profile-merge'))
    fs.writeFileSync(join(f.profileHome, 'projects.orca-profile-merge/session.jsonl'), 'saved')
    shareClaudeProfileHistory(f)
    expect(fs.realpathSync(join(f.profileHome, 'projects'))).toBe(
      fs.realpathSync(join(f.defaultHome, 'projects'))
    )
    expect(fs.readFileSync(join(f.defaultHome, 'projects/session.jsonl'), 'utf8')).toBe('saved')
  })
  it('retains prompt cursors, drains late appends and repairs a CLI replacement', () => {
    const f = fixture()
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'default')
    fs.writeFileSync(join(f.profileHome, 'history.jsonl'), 'profile\n')
    shareClaudeProfileHistory(f)
    const pending = join(f.profileHome, 'history.jsonl.orca-profile-merge')
    fs.appendFileSync(pending, 'late\n')
    shareClaudeProfileHistory(f)
    shareClaudeProfileHistory(f)
    expect(fs.readFileSync(join(f.defaultHome, 'history.jsonl'), 'utf8')).toBe(
      'default\nprofile\nlate\n'
    )
    fs.writeFileSync(join(f.profileHome, 'replacement'), 'replacement\n')
    fs.renameSync(join(f.profileHome, 'replacement'), join(f.profileHome, 'history.jsonl'))
    shareClaudeProfileHistory(f)
    expect(fs.realpathSync(join(f.profileHome, 'history.jsonl'))).toBe(
      fs.realpathSync(join(f.defaultHome, 'history.jsonl'))
    )
    expect(fs.readFileSync(join(f.defaultHome, 'history.jsonl'), 'utf8')).toContain('replacement\n')
  })
  it('selects Windows junctions/hardlinks and recognizes an existing hardlink', () => {
    const f = fixture()
    shareClaudeProfileHistory({ ...f, platform: 'win32' })
    expect(fs.linkSync).toHaveBeenCalledWith(
      join(f.defaultHome, 'history.jsonl'),
      join(f.profileHome, 'history.jsonl')
    )
    expect(fs.symlinkSync).toHaveBeenCalledWith(
      join(f.defaultHome, 'projects'),
      join(f.profileHome, 'projects'),
      'junction'
    )
    fs.appendFileSync(join(f.profileHome, 'history.jsonl'), 'one\n')
    shareClaudeProfileHistory({ ...f, platform: 'win32' })
    expect(fs.readFileSync(join(f.defaultHome, 'history.jsonl'), 'utf8')).toBe('one\n')
  })
  it('keeps private history with a warning if Windows hardlink publication fails', () => {
    const f = fixture()
    fs.writeFileSync(join(f.profileHome, 'history.jsonl'), 'private')
    vi.mocked(fs.linkSync).mockImplementationOnce(() => {
      throw new Error('unsupported filesystem')
    })
    expect(shareClaudeProfileHistory({ ...f, platform: 'win32' })['history.jsonl']).toContain(
      'unsupported filesystem'
    )
    expect(fs.readFileSync(join(f.profileHome, 'history.jsonl'), 'utf8')).toBe('private')
  })
})
