import { expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from './child-process/run-process'
import { fileURLToPath } from 'node:url'
it.skipIf(process.platform === 'win32')(
  'retains existing permissions when the process umask is stricter',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-plugin-umask-'))
    const pluginPath = join(root, 'plugin.js')
    const modulePath = fileURLToPath(new URL('./opencode-plugin-atomic-write.ts', import.meta.url))
    try {
      const result = await runProcess({
        program: process.execPath,
        args: [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `
        import { chmodSync, statSync, writeFileSync } from 'node:fs';
        import { createRequire } from 'node:module';
        const { writeCanonicalOpenCodePluginAtomically } = createRequire(import.meta.url)(${JSON.stringify(modulePath)});
        const target = ${JSON.stringify(pluginPath)};
        writeFileSync(target, 'old');
        chmodSync(target, 0o664);
        process.umask(0o027);
        writeCanonicalOpenCodePluginAtomically(target, 'new');
        console.log(statSync(target).mode & 0o777);
      `
        ],
        timeoutMs: 10_000,
        maxOutputBytes: 4_096
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe(String(0o664))
      expect(readFileSync(pluginPath, 'utf8')).toBe('new')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
