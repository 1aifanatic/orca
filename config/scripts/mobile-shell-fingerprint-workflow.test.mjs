import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/mobile-shell-fingerprint.yml', 'utf8'))
const steps = workflow.jobs['shell-fingerprint'].steps
const scopeScript = steps.find((step) => step.id === 'scope').run
const matcher = /shell_paths=\([\s\S]*?\n\}\n/.exec(scopeScript)?.[0]

function bashShellPaths() {
  const list = /shell_paths=\(\n([\s\S]*?)\n\s*\)/.exec(scopeScript)[1]
  return list
    .split('\n')
    .map((line) => line.trim())
    .map((line) => line.replace(/^'(.*)'$/, '$1'))
}

describe('mobile shell fingerprint workflow', () => {
  // A push that reverts the last shell edit must still run, or the label outlives the change.
  it('runs on every pull request and filters paths only on main', () => {
    expect(workflow.on.pull_request.paths).toBeUndefined()
    expect(workflow.on.push.paths.length).toBeGreaterThan(0)
  })

  it('matches pull requests against the same shell paths main filters on', () => {
    expect(bashShellPaths()).toEqual(workflow.on.push.paths)
  })

  it.skipIf(process.platform === 'win32')('matches files the way the paths filter does', () => {
    expect(matcher).toBeDefined()
    const files = [
      'mobile/src/app.ts',
      'src/shared/protocol-version.ts',
      'mobile/rpc-foundation/goldens/a.json',
      'mobile/src/app.test.ts',
      'src/renderer/a.ts',
      '.github/workflows/mobile-shell-fingerprint.yml'
    ]
    const script = `${matcher}\nfor f in ${files.map((file) => `'${file}'`).join(' ')}; do if touches_shell "$f"; then echo "$f"; fi; done`
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual([
      'mobile/src/app.ts',
      'src/shared/protocol-version.ts',
      '.github/workflows/mobile-shell-fingerprint.yml'
    ])
  })
})
