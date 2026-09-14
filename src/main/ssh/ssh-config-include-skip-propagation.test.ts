import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as OsModule from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeSshConfigIncludeSkips,
  expandSshConfigIncludes
} from './ssh-config-include-expander'
import {
  invalidateSshConfigAliasClaimCache,
  loadUserSshConfigAliasClaims,
  sshConfigMayClaimAlias
} from './ssh-config-alias-claim'
import {
  invalidateUserSshConfigHostCache,
  listUserSshConfigHostSummaries
} from './ssh-config-host-picker'
import { loadUserSshConfig } from './ssh-config-parser'

const { homedirMock, hostnameMock, userInfoMock } = vi.hoisted(() => ({
  homedirMock: vi.fn(() => '/home/testuser'),
  hostnameMock: vi.fn(() => 'workstation.example.com'),
  userInfoMock: vi.fn(() => ({ username: 'testuser', uid: 1001 }))
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof OsModule>('os')
  return { ...actual, homedir: homedirMock, hostname: hostnameMock, userInfo: userInfoMock }
})

const tempDirs: string[] = []
const lockedPaths: string[] = []

/** `rmSync`'s `force` only ignores ENOENT, so a directory left at mode 000 by a failing assertion
 *  would make the cleanup below throw EACCES and mask the real failure. Unlock centrally instead. */
function lockPath(path: string): string {
  chmodSync(path, 0o000)
  lockedPaths.push(path)
  return path
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  invalidateSshConfigAliasClaimCache()
  invalidateUserSshConfigHostCache()
  while (lockedPaths.length > 0) {
    chmodSync(lockedPaths.pop() as string, 0o700)
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { force: true, recursive: true })
  }
})

/** The expander canonicalises paths, and macOS `tmpdir()` is a symlink (`/var` -> `/private/var`),
 *  so a skip target compared against an uncanonicalised temp path would never match. */
function makeTemporaryHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'orca-ssh-include-skip-')))
  tempDirs.push(home)
  homedirMock.mockReturnValue(home)
  return home
}

function writeFile(root: string, relativePath: string, content: string): string {
  const fullPath = join(root, relativePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
  return fullPath
}

/** A home whose `~/.ssh/config` includes `config.d/*`, with one host declared inline. */
function makeHomeWithIncludeDirectory(): { home: string; configPath: string } {
  const home = makeTemporaryHome()
  const configPath = writeFile(
    home,
    '.ssh/config',
    'Include config.d/*\n\nHost rootonly\n  HostName root.example.com\n'
  )
  mkdirSync(join(home, '.ssh', 'config.d'), { recursive: true })
  return { home, configPath }
}

describe('ssh_config Include skips', () => {
  it('does not record a skip for an Include that simply is not there', () => {
    const home = makeTemporaryHome()
    writeFile(home, '.ssh/config', 'Include absent.d/*\n\nHost solo\n  HostName solo.example.com\n')

    const loaded = loadUserSshConfig()
    // OpenSSH ignores absent Include paths, so absence is a real negative answer.
    expect(loaded.skippedIncludes).toEqual([])
    expect(loaded.hosts.map((host) => host.host)).toEqual(['solo'])
  })

  it('records a directory named by an Include as a skip rather than as no hosts', () => {
    const { home } = makeHomeWithIncludeDirectory()
    mkdirSync(join(home, '.ssh', 'config.d', 'nested'), { recursive: true })

    const expansion = expandSshConfigIncludes(join(home, '.ssh', 'config'))
    expect(expansion.skippedIncludes).toEqual([
      { target: join(home, '.ssh', 'config.d', 'nested'), reason: 'not-a-regular-file' }
    ])
    // The rest of the config still parses: the skip is additive, not a bail-out.
    expect(expansion.content).toContain('Host rootonly')
  })

  it.runIf(process.platform !== 'win32')(
    'records an Include it can see but cannot read as unreadable',
    () => {
      const { home } = makeHomeWithIncludeDirectory()
      const included = writeFile(
        home,
        '.ssh/config.d/50-prod',
        'Host prod\n  HostName prod.internal\n'
      )
      lockPath(included)

      const loaded = loadUserSshConfig()
      expect(loaded.skippedIncludes).toEqual([{ target: included, reason: 'unreadable' }])
      expect(loaded.hosts.map((host) => host.host)).toEqual(['rootonly'])
    }
  )

  it.runIf(process.platform !== 'win32')(
    'records an exact Include path hidden behind an unreadable directory',
    () => {
      const home = makeTemporaryHome()
      writeFile(
        home,
        '.ssh/config',
        'Include config.d/50-prod\n\nHost rootonly\n  HostName r.example.com\n'
      )
      writeFile(home, '.ssh/config.d/50-prod', 'Host prod\n  HostName prod.internal\n')
      const includeDir = lockPath(join(home, '.ssh', 'config.d'))

      // existsSync answers false here, which is the swallow: the file is there and unread.
      const loaded = loadUserSshConfig()
      expect(loaded.skippedIncludes).toEqual([
        { target: join(includeDir, '50-prod'), reason: 'unreadable' }
      ])
      expect(loaded.hosts.map((host) => host.host)).toEqual(['rootonly'])
    }
  )

  it.runIf(process.platform !== 'win32')(
    'records a glob over an unreadable directory, which matches nothing without throwing',
    () => {
      const { home } = makeHomeWithIncludeDirectory()
      writeFile(home, '.ssh/config.d/50-prod', 'Host prod\n  HostName prod.internal\n')
      const includeDir = lockPath(join(home, '.ssh', 'config.d'))

      // globSync answers `[]` here rather than throwing, so the catch around it never fires: this is
      // the motivating bug in its commonest form, `chmod 000` on a config.d full of hosts. The skip
      // names the directory rather than the pattern: that is the path the user has to chmod, and two
      // patterns over one locked directory are one cause, not two warnings.
      const loaded = loadUserSshConfig()
      expect(loaded.skippedIncludes).toEqual([{ target: includeDir, reason: 'unreadable' }])
      expect(loaded.hosts.map((host) => host.host)).toEqual(['rootonly'])
    }
  )

  it.runIf(process.platform !== 'win32')(
    'records the unreadable subdirectory behind a partial glob expansion',
    () => {
      const home = makeTemporaryHome()
      writeFile(
        home,
        '.ssh/config',
        'Include config.d/*/config\n\nHost rootonly\n  HostName r.example.com\n'
      )
      writeFile(home, '.ssh/config.d/work/config', 'Host work\n  HostName work.internal\n')
      writeFile(home, '.ssh/config.d/personal/config', 'Host personal\n  HostName p.internal\n')
      const locked = lockPath(join(home, '.ssh', 'config.d', 'personal'))

      // The dangerous half: globSync returns the one match it could see, so a length check on the
      // result proves nothing. `work` is included, `personal` is missing, and nothing said so.
      const loaded = loadUserSshConfig()
      expect(loaded.skippedIncludes).toEqual([{ target: locked, reason: 'unreadable' }])
      expect(loaded.hosts.map((host) => host.host).sort()).toEqual(['rootonly', 'work'])

      // And the point of recording it: the alias claim must stay unproven, because a confident
      // `false` here is licence to override the `Host personal` block the user did write.
      expect(sshConfigMayClaimAlias('personal', loadUserSshConfigAliasClaims())).toBe(true)
    }
  )

  it.runIf(process.platform !== 'win32')(
    'records an unreadable level even when the glob matched nothing at all',
    () => {
      const home = makeTemporaryHome()
      writeFile(
        home,
        '.ssh/config',
        'Include config.d/*/config\n\nHost rootonly\n  HostName r.example.com\n'
      )
      writeFile(home, '.ssh/config.d/personal/config', 'Host personal\n  HostName p.internal\n')
      const locked = lockPath(join(home, '.ssh', 'config.d', 'personal'))

      // Zero matches, yet `~/.ssh/config.d` -- the literal prefix -- opens fine. Checking only that
      // prefix would read this as proven absence.
      expect(loadUserSshConfig().skippedIncludes).toEqual([
        { target: locked, reason: 'unreadable' }
      ])
    }
  )

  it('leaves a glob that genuinely matches nothing alone', () => {
    const { home } = makeHomeWithIncludeDirectory()

    // The directory is there and readable; an empty one is a real "no hosts included".
    expect(expandSshConfigIncludes(join(home, '.ssh', 'config')).skippedIncludes).toEqual([])
  })

  it('treats an Include under a regular file as absence, not as unread', () => {
    const home = makeTemporaryHome()
    writeFile(
      home,
      '.ssh/config',
      'Include notadir/50-prod\n\nHost rootonly\n  HostName r.example.com\n'
    )
    writeFile(home, '.ssh/notadir', 'this is a file\n')

    // ENOTDIR: a path under a regular file cannot exist, so OpenSSH would include nothing either.
    expect(loadUserSshConfig().skippedIncludes).toEqual([])
  })

  it('summarises skips for a log line and says nothing when there are none', () => {
    expect(describeSshConfigIncludeSkips([])).toBeNull()
    expect(
      describeSshConfigIncludeSkips([
        { target: '/home/u/.ssh/config.d/50-prod', reason: 'unreadable' }
      ])
    ).toContain('/home/u/.ssh/config.d/50-prod')
  })
})

describe('listUserSshConfigHostSummaries', () => {
  it('reports the unread Include targets alongside the short host list', () => {
    const { home } = makeHomeWithIncludeDirectory()
    mkdirSync(join(home, '.ssh', 'config.d', 'nested'), { recursive: true })

    const first = listUserSshConfigHostSummaries([], '', [], { refresh: true })
    expect(first.hosts.map((host) => host.alias)).toEqual(['rootonly'])
    expect(first.skippedIncludes).toEqual([join(home, '.ssh', 'config.d', 'nested')])

    // The picker holds the parse for the session; the reason the list is short has to survive with
    // it, or the second keystroke reads as an authoritative answer.
    expect(listUserSshConfigHostSummaries([], 'root', [], {}).skippedIncludes).toEqual(
      first.skippedIncludes
    )
  })

  it('omits the field entirely when the config was read completely', () => {
    const { home } = makeHomeWithIncludeDirectory()
    writeFile(home, '.ssh/config.d/50-prod', 'Host prod\n  HostName prod.internal\n')

    const result = listUserSshConfigHostSummaries([], '', [], { refresh: true })
    expect(result.hosts.map((host) => host.alias).sort()).toEqual(['prod', 'rootonly'])
    expect('skippedIncludes' in result).toBe(false)
  })
})

describe('loadUserSshConfigAliasClaims', () => {
  it('caches the uncertainty under the TTL instead of a wrong "unclaimed"', () => {
    vi.useFakeTimers()
    const home = makeTemporaryHome()
    // An unexpandable Include drives this rather than an unreadable file: it needs no chmod, so the
    // TTL contract is covered on Windows too.
    writeFile(
      home,
      '.ssh/config',
      'Include ${ORCA_TEST_SSH_INCLUDE_DIR}/extra.conf\n\nHost rootonly\n  HostName r.example.com\n'
    )

    // First probe: the Include that could have claimed an alias was not read, so the claims are
    // unknown -- and unknown must answer "may claim", never "unclaimed".
    expect(loadUserSshConfigAliasClaims()).toBeNull()
    expect(sshConfigMayClaimAlias('prod', loadUserSshConfigAliasClaims())).toBe(true)

    // Later calls inside the TTL are served from the cache: removing the cause changes nothing yet.
    vi.stubEnv('ORCA_TEST_SSH_INCLUDE_DIR', join(home, '.ssh', 'config.d'))
    expect(loadUserSshConfigAliasClaims()).toBeNull()

    // ...and the entry is bounded, so the recovered config is picked up without a relaunch.
    vi.advanceTimersByTime(6_000)
    expect(loadUserSshConfigAliasClaims()).not.toBeNull()
  })

  it('proves absence once the whole config was readable', () => {
    const { home } = makeHomeWithIncludeDirectory()
    writeFile(home, '.ssh/config.d/50-wildcard', 'Host *\n  ForwardAgent yes\n')

    expect(sshConfigMayClaimAlias('prod', loadUserSshConfigAliasClaims())).toBe(false)
  })

  it('still proves absence when a glob matched a subdirectory', () => {
    const { home } = makeHomeWithIncludeDirectory()
    mkdirSync(join(home, '.ssh', 'config.d', 'backup'), { recursive: true })

    // OpenSSH reads no Host block out of a directory either, so this skip hides nothing and must not
    // cost every alias its proof -- a kept `config.d/backup/` would otherwise pin "may claim".
    expect(sshConfigMayClaimAlias('prod', loadUserSshConfigAliasClaims())).toBe(false)
    // The picker still reports it; only the claim proof ignores it.
    expect(
      expandSshConfigIncludes(join(home, '.ssh', 'config')).skippedIncludes.map(
        (skip) => skip.reason
      )
    ).toEqual(['not-a-regular-file'])
  })
})
