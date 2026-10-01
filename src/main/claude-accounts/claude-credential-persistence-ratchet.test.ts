import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { stripComments } from '../../shared/source-scan/source-tree-scan'

const src = join(__dirname, '../..')

/**
 * Every place a Claude login could be written from: accounts, usage, launch, hooks, the CLI, the
 * relay and the generated shell scripts. Plan §9 lists these; credential checks run on all of them.
 */
const credentialRoots: readonly (string | { root: string; only: RegExp })[] = [
  'main/claude-accounts',
  // Other providers there refresh their own logins; only Claude's usage is in scope.
  { root: 'main/rate-limits', only: /[\\/]claude[^\\/]*\.ts$/ },
  'main/claude',
  'main/native-chat',
  'main/ipc/pty',
  'main/daemon',
  'main/providers',
  'main/macos-keychain',
  'cli',
  'relay',
  'shared'
]

/**
 * Only noncredential profile surfaces may persist bytes, and each only with the primitives it
 * uses today; a new primitive in one of them is a review, not a silent pass.
 */
const fsAllowances: Record<string, readonly string[]> = {
  'claude-accounts/claude-profile-history.ts': [
    'mkdirSync',
    'renameSync',
    'rmdirSync',
    'symlinkSync'
  ],
  'claude-accounts/claude-profile-paths.ts': ['mkdirSync', 'writeFileAtomically'],
  'claude-accounts/claude-profile-pointer.ts': ['mkdirSync', 'rmSync', 'writeFileAtomically'],
  'claude-accounts/claude-profile-prompt-history.ts': [
    'appendFileSync',
    'linkSync',
    'openSync',
    'renameSync',
    'rmSync',
    'symlinkSync',
    'unlinkSync',
    'writeFileSync',
    'writeFileAtomically'
  ],
  'claude-accounts/claude-profile-provisioning.ts': ['mkdirSync', 'rmSync', 'writeFileAtomically'],
  'claude-accounts/claude-profile-sharing.ts': [
    'mkdirSync',
    'rmdirSync',
    'symlinkSync',
    'unlinkSync',
    'writeFileAtomically'
  ],
  // The pointer queue's own serialized-write method, not a filesystem primitive.
  'claude-accounts/claude-profile-pointer-queue.ts': ['write'],
  'claude-accounts/claude-profile-routing-service.ts': ['write'],
  // The guest helper answers the host on stdout.
  'claude-accounts/claude-profile-wsl-entry.ts': ['write']
}
const mutation =
  /^(?:write(?:File|Json|Sync|v|.*Credentials|.*Keychain)?$|write(?:File|Json)|appendFile|copyFile|cp(?:Sync)?$|rename(?:Sync)?$|unlink(?:Sync)?$|rm(?:dir)?(?:Sync)?$|truncate(?:Sync)?$|createWriteStream|symlink(?:Sync)?$|link(?:Sync)?$|chmod(?:Sync)?$|mkdir(?:Sync)?$|mkdtemp(?:Sync)?$|open(?:Sync)?$|delete.*Keychain|refreshClaudeOauth)/

function persistencePrimitives(text: string): string[] {
  const found = new Set<string>()
  // Import-side names survive aliases, including destructuring and wrapped helper calls.
  for (const match of text.matchAll(/\b([a-zA-Z_$][\w$]*)\s*(?=\(|as\s|[:,}])/g)) {
    if (mutation.test(match[1])) {
      found.add(match[1])
    }
  }
  return [...found]
}

/** Credential writes refused everywhere scanned, whatever form the call takes. */
function credentialMutations(text: string): string[] {
  const found: string[] = []
  // Argv (`['add-generic-password', …]`) and shell (`security add-generic-password`) forms.
  if (/(?:add|delete)-generic-password/.test(text)) {
    found.push('keychain write')
  }
  if (/\b(?:write|delete|store|save)\w*Keychain\w*\b/.test(text)) {
    found.push('keychain helper')
  }
  if (/oauth\/token|grant_type|\brefresh_token\b/.test(text)) {
    found.push('token refresh')
  }
  // A statement that names the credentials file together with anything that writes, copies,
  // moves or opens it for writing (TS calls and generated shell alike).
  for (const statement of text.split(/;|\n\s*\n/)) {
    if (
      statement.includes('.credentials.json') &&
      /\b(?:write\w*|append\w*|copy\w*|cp(?:Sync)?|rename\w*|link\w*|symlink\w*|createWriteStream|mv|tee|install)\b|\bopen(?:Sync)?\s*\([\s\S]{0,200}?,\s*['"`](?:w|a|r\+|wx|ax)|>\s*["'$]/.test(
        statement
      )
    ) {
      found.push('credentials file write')
    }
  }
  return found
}

function files(dir: string): string[] {
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name)
    return entry.isDirectory()
      ? entry.name === 'node_modules' || entry.name === '__fixtures__'
        ? []
        : files(file)
      : /\.(?:ts|tsx|mts|cts|js|mjs|cjs|sh)$/.test(entry.name) &&
          !/\.test\.|\.spec\.|test-harness|harness\.ts|test-fixtures|test-utils/.test(entry.name)
        ? [file]
        : []
  })
}

it('keeps every Claude credential writer removed, in every form and on every launch path', () => {
  const violations = credentialRoots
    .flatMap((entry) => {
      const { root, only } = typeof entry === 'string' ? { root: entry, only: null } : entry
      const dir = join(src, root)
      const found = statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? files(dir) : []
      return only ? found.filter((file) => only.test(file)) : found
    })
    .flatMap((file) =>
      credentialMutations(stripComments(readFileSync(file, 'utf8'))).map(
        (kind) => `${relative(src, file)}: ${kind}`
      )
    )
  expect(violations).toEqual([])
})

it('confines filesystem persistence in accounts and usage to named profile surfaces', () => {
  const main = join(src, 'main')
  const candidates = [
    ...files(__dirname),
    ...files(join(main, 'rate-limits')).filter((file) => /\/claude[^/]*\.ts$/.test(file))
  ]
  const violations = candidates.flatMap((file) => {
    const name = relative(main, file).replaceAll('\\', '/')
    const allowed = new Set(fsAllowances[name] ?? [])
    return persistencePrimitives(stripComments(readFileSync(file, 'utf8')))
      .filter((primitive) => !allowed.has(primitive))
      .map((primitive) => `${name}: ${primitive}`)
  })
  expect(violations).toEqual([])
  const cli = readFileSync(join(main, '../cli/handlers/account.ts'), 'utf8')
  expect(cli).not.toMatch(/Keychain|orca-account-add-claude|addClaudeFromConfigDir/)
  const auth = readFileSync(join(__dirname, 'runtime-auth-service.ts'), 'utf8')
  expect(auth).not.toMatch(/extends ClaudeRuntimeAuth|snapshot|credentialsJson|readBack/i)
})

it.each([
  "import { writeFile as save } from 'node:fs/promises'; save(path, token)",
  "import * as fs from 'node:fs'; const save = () => fs.writeFileSync(path, token)",
  "import { writeFileAtomically as persist } from '../codex-accounts/fs-utils'; persist(path, token)",
  'fs.copyFile(source, destination)',
  'fs.symlink(credentialPath, destination)',
  "const fd = openSync(join(dir, 'x'), 'w'); writeSync(fd, token)",
  'await fs.promises.cp(a, b)',
  'fs.cpSync(a, b, { recursive: true })'
])('mutation control: the filesystem census rejects %s', (source) => {
  expect(persistencePrimitives(source).length).toBeGreaterThan(0)
})

it.each([
  'security add-generic-password -s Claude -w token',
  "await execFileAsync('security', ['add-generic-password', '-U', '-s', service, '-w', token])",
  "execFileSync('security', ['delete-generic-password', '-s', 'Claude Code-credentials'])",
  "import { writeKeychainPassword as persist } from '../macos-keychain/generic-password'; persist(service, user, token)",
  "const fd = openSync(join(dir, '.credentials.json'), 'w'); writeSync(fd, token)",
  "await fs.promises.cp(join(a, '.credentials.json'), join(b, '.credentials.json'))",
  "copyFileSync(join(from, '.credentials.json'), join(home, '.credentials.json'))",
  "const script = 'cp source .credentials.json'",
  'const script = `printf %s "$token" > "$HOME/.claude/.credentials.json"`',
  "fetch('https://api.anthropic.com/v1/oauth/token')",
  "body: JSON.stringify({ grant_type: 'refresh_token' })"
])('mutation control: the credential check rejects %s', (source) => {
  expect(credentialMutations(source).length).toBeGreaterThan(0)
})

it.each([
  "const file = await readFile(join(home, '.credentials.json'), 'utf8')",
  "readKeychainPassword('Claude Code-credentials', user)"
])('the credential check leaves a read alone: %s', (source) => {
  expect(credentialMutations(source)).toEqual([])
})
