import { expect, it } from 'vitest'
import { resolveConfiguredWorkerAgent } from './configured-worker-agent-selector'

it('reuses the configured built-in grammar for a direct vendor executable', () => {
  expect(resolveConfiguredWorkerAgent('codex-fugu', { codex: 'codex-fugu' })).toBe('codex')
  expect(resolveConfiguredWorkerAgent('claude-fugu', { claude: 'claude-fugu' })).toBe('claude')
})
it('keeps canonical IDs authoritative even when their command has an alias', () => {
  expect(resolveConfiguredWorkerAgent('codex', { codex: 'codex-fugu' })).toBe('codex')
})
it('requires explicit configuration instead of guessing a PATH command grammar', () => {
  expect(resolveConfiguredWorkerAgent('codex-fugu', {})).toBeUndefined()
  expect(resolveConfiguredWorkerAgent('node', { codex: 'node vendor.js' })).toBeUndefined()
})
it('recognizes quoted native and Windows paths without changing the configured command', () => {
  expect(
    resolveConfiguredWorkerAgent(
      'opencode-private',
      {
        opencode: "'/tmp/agent directory/opencode-private'"
      },
      'darwin'
    )
  ).toBe('opencode')
  expect(
    resolveConfiguredWorkerAgent(
      'codex-fugu',
      {
        codex: '"C:\\Agent Directory\\codex-fugu.exe"'
      },
      'win32'
    )
  ).toBe('codex')
})
it('refuses ambiguous aliases instead of selecting a different provider grammar', () => {
  expect(() =>
    resolveConfiguredWorkerAgent('vendor', {
      codex: 'vendor',
      claude: 'vendor'
    })
  ).toThrow('multiple launchers')
})
