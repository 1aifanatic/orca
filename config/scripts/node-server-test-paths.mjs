export function nodeServerTestPaths({ artifact = false } = {}) {
  return [
    'src/main/persistence/profile-state',
    'src/main/persistence/loading-store/profile-state',
    'src/main/sqlite',
    'src/main/orcad/orcad-entry.test.ts',
    'src/main/orcad/orcad-push-startup.test.ts',
    'src/main/daemon/pty-subprocess',
    ...(artifact
      ? [
          'tests/e2e/daemon-running-work-probe.unit.test.ts',
          'src/main/orcad/orcad-packaged-node-pty.integration.test.ts',
          'src/main/providers/agent-foreground-process-git-bash.win32.test.ts',
          'src/main/orcad/orcad-node-launcher.integration.test.ts',
          'config/scripts/zip-extractor-command.test.mjs'
        ]
      : [])
  ]
}
