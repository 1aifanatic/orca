import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

// Ported module-boundary census: only noncredential profile surfaces may persist bytes.
const surfaceWriters = new Set([
  'claude-profile-paths.ts',
  'claude-profile-provisioning.ts',
  'claude-profile-history.ts',
  'claude-profile-sharing.ts',
  'claude-profile-pointer.ts',
  'claude-profile-history-file.ts',
  'claude-profile-history-directory.ts',
  'claude-profile-ledger.ts',
  'claude-profile-prompt-history.ts'
])
const mutation =
  /^(?:write(?:File|Json|.*Credentials|.*Keychain)|appendFile|copyFile|rename(?:Sync)?$|unlink(?:Sync)?$|rm(?:Sync)?$|truncate(?:Sync)?$|createWriteStream|symlink(?:Sync)?$|link(?:Sync)?$|chmod(?:Sync)?$|mkdir(?:Sync)?$|mkdtemp(?:Sync)?$|delete.*Keychain|refreshClaudeOauth)/
function persistencePrimitives(text: string): string[] {
  const found = new Set<string>()
  // Import-side names survive aliases, including destructuring and wrapped helper calls.
  for (const match of text.matchAll(/\b([a-zA-Z_$][\w$]*)\s*(?=\(|as\s|[:,}])/g)) {
    if (mutation.test(match[1])) {
      found.add(match[1])
    }
  }
  if (
    /security\s+(?:add|delete)-generic-password|(?:cp|mv|rm|tee)\s[^\n]*\.credentials\.json|oauth\/token/.test(
      text
    )
  ) {
    found.add('generated credential mutation')
  }
  return [...found]
}
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name)
    return entry.isDirectory()
      ? files(file)
      : entry.name.endsWith('.ts') && !/test|harness/.test(entry.name)
        ? [file]
        : []
  })
}
it('keeps all credential writers removed and confines filesystem persistence to profile surfaces', () => {
  const main = join(__dirname, '..')
  const candidates = [
    ...files(__dirname),
    ...files(join(main, 'rate-limits')).filter((file) => /\/claude[^/]*\.ts$/.test(file))
  ]
  const violations = candidates.flatMap((file) => {
    if (surfaceWriters.has(file.slice(file.lastIndexOf('/') + 1))) {
      return []
    }
    const source = readFileSync(file, 'utf8')
    return persistencePrimitives(source).map((name) => `${relative(main, file)}: ${name}`)
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
  "import { writeKeychainPassword as persist } from '../macos-keychain/generic-password'; persist(service, user, token)",
  'fs.copyFile(source, destination)',
  'fs.symlink(credentialPath, destination)',
  'security add-generic-password -s Claude -w token',
  "const script = 'cp source .credentials.json'",
  "fetch('https://api.anthropic.com/v1/oauth/token')"
])('mutation control rejects a reintroduced persistence primitive: %s', (source) => {
  expect(persistencePrimitives(source).length).toBeGreaterThan(0)
})
