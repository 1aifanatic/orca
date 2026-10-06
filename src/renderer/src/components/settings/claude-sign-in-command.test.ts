import { expect, it } from 'vitest'
import { buildClaudeSignInCommand } from './claude-sign-in-command'

it("signs in through the real claude, not Orca's account function", () => {
  expect(
    buildClaudeSignInCommand({ configDir: '/data/a/home', runtime: 'host' }, 'posix').command
  ).toBe("CLAUDE_CONFIG_DIR='/data/a/home' command claude auth login")
  expect(
    buildClaudeSignInCommand({ configDir: 'C:\\data\\a\\home', runtime: 'host' }, 'win32').command
  ).toBe(
    "$env:CLAUDE_CONFIG_DIR = 'C:\\data\\a\\home'; & (Get-Command claude -CommandType Application,ExternalScript | Select-Object -First 1).Source auth login"
  )
})
