import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import { editorTabFileAccess } from './local-file-access'

const initialState = useAppStore.getInitialState()

function makeRepo(overrides: Partial<Repo> & { id: string; path: string }): Repo {
  return { displayName: 'repo', badgeColor: '#000', addedAt: 0, ...overrides }
}

function makeWorktree(overrides: Partial<Worktree> & { id: string; repoId: string }): Worktree {
  return {
    path: '/Users/me/project',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'project',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const localWorktreeId = 'repo-local::/Users/me/project'

type TabShape = Parameters<typeof editorTabFileAccess>[1]

function accessKind(file: TabShape): string | undefined {
  return editorTabFileAccess(useAppStore.getState(), file)?.kind
}

describe('editorTabFileAccess', () => {
  beforeEach(() => {
    useAppStore.setState({
      repos: [
        makeRepo({ id: 'repo-local', path: '/Users/me/project' }),
        makeRepo({ id: 'repo-ssh', path: '/work/project', connectionId: 'ssh-1' })
      ],
      worktreesByRepo: {
        'repo-local': [makeWorktree({ id: localWorktreeId, repoId: 'repo-local' })]
      }
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it.each<[string, TabShape, string | undefined]>([
    [
      'a floating-workspace tab stored relative to ~',
      {
        filePath: '/Users/me/notes.txt',
        relativePath: 'notes.txt',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID
      },
      'user-file'
    ],
    [
      'a local tab stored by absolute path',
      { filePath: '/tmp/audit.md', relativePath: '/tmp/audit.md', worktreeId: localWorktreeId },
      'user-file'
    ],
    [
      'an AI Vault log tab in an SSH workspace',
      {
        filePath: '/Users/me/.codex/session.jsonl',
        relativePath: '/Users/me/.codex/session.jsonl',
        worktreeId: 'repo-ssh::/work/project',
        readOnly: true,
        liveTail: true
      },
      'user-file'
    ],
    [
      'a project tab, which stays inside its root',
      { filePath: '/Users/me/project/a.ts', relativePath: 'a.ts', worktreeId: localWorktreeId },
      undefined
    ],
    [
      'an absolute tab owned by an SSH workspace',
      { filePath: '/work/x.md', relativePath: '/work/x.md', worktreeId: 'repo-ssh::/work/project' },
      undefined
    ],
    [
      'an absolute tab pinned to an SSH host',
      {
        filePath: '/work/x.md',
        relativePath: '/work/x.md',
        worktreeId: localWorktreeId,
        externalSshTargetId: 'ssh-1'
      },
      undefined
    ],
    [
      'a floating tab owned by a remote runtime',
      {
        filePath: '/Users/me/notes.txt',
        relativePath: 'notes.txt',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: 'runtime-1'
      },
      undefined
    ],
    [
      'an absolute tab whose owner has not loaded',
      {
        filePath: '/work/x.md',
        relativePath: '/work/x.md',
        worktreeId: 'repo-missing::/work/other'
      },
      undefined
    ],
    [
      'an absolute tab in a folder workspace with an unknown host',
      {
        filePath: '/home/remote/notes.md',
        relativePath: '/home/remote/notes.md',
        worktreeId: folderWorkspaceKey('fw-missing')
      },
      undefined
    ]
  ])('%s', (_label, file, expected) => {
    expect(accessKind(file)).toBe(expected)
  })
})

// Why a ratchet: a content-driven reader adopting user-file would bring back the round-1 leak, so
// every new importer must be a deliberate, reviewed addition to this list.
const USER_NAMED_ACCESS_IMPORTERS = [
  'components/browser-pane/describe-page/browser-artifact-upload.ts',
  'components/browser-pane/navigate/navigate-browser-page-url.ts',
  'components/native-chat/NativeChatImageAttachmentPreview.tsx',
  'components/native-chat/NativeChatTranscriptChrome.tsx',
  'components/sidebar/useSidebarProjectDrop.ts',
  'components/tab-bar/tab-create-entry-absolute-file.ts',
  'components/terminal-pane/terminal-file-open-routing.ts',
  'hooks/composer-state/attachment-drop-state.ts',
  'hooks/useGlobalFileDrop.ts',
  'lib/local-file-access.ts'
]

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      return collectSourceFiles(full)
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : []
  })
}

describe('user-named file access ratchet', () => {
  it('is constructed only by gesture sites and the editor-tab rule', () => {
    const rendererRoot = resolve(__dirname, '..')
    const importers = collectSourceFiles(rendererRoot)
      .filter((file) =>
        /\buserNamedFileAccess\b|kind: 'user-file'/.test(readFileSync(file, 'utf8'))
      )
      .map((file) => relative(rendererRoot, file).split('\\').join('/'))
      .sort()

    expect(importers).toEqual(USER_NAMED_ACCESS_IMPORTERS)
  })
})
