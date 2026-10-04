import { describe, expect, it } from 'vitest'
import {
  attributeTopologyWriter,
  TEST_SEED_WRITER,
  UNKNOWN_WRITER
} from './terminal-topology-writer-attribution'

const ROOT = '/repo'
const frame = (path: string, fn = 'fn'): string => `    at ${fn} (${path}:10:5)`
const stack = (...frames: string[]): string => ['Error: topology sink write', ...frames].join('\n')

describe('topology writer attribution', () => {
  it('skips the sinks and their funnels and names the first source frame', () => {
    expect(
      attributeTopologyWriter(
        stack(
          frame('/repo/src/main/persistence/terminal-topology/terminal-topology-write-guard.ts'),
          frame('/repo/src/main/persistence/loading-store/session-snapshot-operations.ts'),
          frame('/repo/src/main/runtime/runtime-workspace-session-controller.ts', 'Controller.set'),
          frame(
            '/repo/src/main/runtime/orca-runtime-get-runtime-id.ts',
            'OrcaRuntimeService.setWorkspaceSessionForWorktree'
          ),
          frame('/repo/src/main/runtime/orca-runtime-persist-headless-terminal-title.ts'),
          frame('/repo/src/main/runtime/caller.test.ts')
        ),
        ROOT
      )
    ).toBe('src/main/runtime/orca-runtime-persist-headless-terminal-title.ts')
  })

  it('names a writer that shares a file with a funnel', () => {
    expect(
      attributeTopologyWriter(
        stack(frame('/repo/src/main/runtime/orca-runtime-get-runtime-id.ts', 'Svc.rogueWrite')),
        ROOT
      )
    ).toBe('src/main/runtime/orca-runtime-get-runtime-id.ts')
  })

  it('keeps nested src segments in the repo-relative path', () => {
    expect(
      attributeTopologyWriter(stack(frame('/repo/src/renderer/src/lib/writer.ts')), ROOT)
    ).toBe('src/renderer/src/lib/writer.ts')
  })

  it('reads tests/ code, test files, fixtures and harnesses as seeding', () => {
    for (const path of [
      '/repo/tests/e2e/folder-upgrade-identity-persistence.unit.test.ts',
      '/repo/tests/e2e/helpers/seed-session.ts',
      '/repo/src/main/a.test.ts',
      '/repo/src/main/persistence-test-harness.ts',
      '/repo/src/main/persistence-session-fixtures.ts'
    ]) {
      expect(attributeTopologyWriter(stack(frame(path)), ROOT)).toBe(TEST_SEED_WRITER)
    }
  })

  it('normalizes Windows paths and file URLs before skipping dependencies', () => {
    expect(
      attributeTopologyWriter(
        stack(
          frame('C:\\repo\\node_modules\\vitest\\dist\\index.js'),
          frame('file:///C:/repo/node_modules/vite-node/dist/client.mjs'),
          frame('c:\\Repo\\src\\main\\ipc\\pty\\pane\\stable-owner.ts')
        ),
        'C:\\Repo\\'
      )
    ).toBe('src/main/ipc/pty/pane/stable-owner.ts')
  })

  it('ignores frames outside the repo and reports unknown when nothing is left', () => {
    expect(
      attributeTopologyWriter(
        stack(frame('/elsewhere/src/main/x.ts'), '    at node:internal/process/task_queues:95:5'),
        ROOT
      )
    ).toBe(UNKNOWN_WRITER)
  })
})
