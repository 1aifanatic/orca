// Workspace and live-shell probes shared by installed-lifecycle drivers.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runProcess } from '../../../src/shared/child-process/run-process.ts'
import { cli, identify, nodeTool, processTable, waitVerdict } from './lifecycle-host.mjs'
import { processVerdict } from './windows-evidence.mjs'

/** `session()` returns the serve currently driven; shells are appended to `owned.shells`. */
export function createWorkspaceTerminals({ root, profile, env, tools, check, owned, session }) {
  async function terminal(worktreeId) {
    const args = ['terminal', 'create', '--worktree', worktreeId, '--shell', 'powershell.exe']
    const { handle } = (await cli(session(), env, args)).terminal
    return { handle, worktreeId, memory: randomBytes(12).toString('hex') }
  }
  // The split nonce keeps echoed input from satisfying the match; $PID proves the same shell process.
  async function observe(item, first = false) {
    await cli(session(), env, ['terminal', 'show', '--terminal', item.handle])
    const nonce = randomBytes(12).toString('hex')
    const text = `${first ? `$env:ORCA_TRANSITION_MEMORY='${item.memory}'; ` : ''}Write-Output ('${nonce.slice(0, 12)}'+'${nonce.slice(12)}:'+$PID+':'+$env:ORCA_TRANSITION_MEMORY)`
    await cli(session(), env, [
      'terminal',
      'send',
      '--terminal',
      item.handle,
      '--text',
      text,
      '--enter'
    ])
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      const read = await cli(session(), env, ['terminal', 'read', '--terminal', item.handle])
      const tail = (read?.terminal?.tail ?? []).map(String).join('\n')
      const match = tail.match(new RegExp(`${nonce}:([0-9]+):${item.memory}(?:\\r?\\n|$)`))
      if (match) {
        const pid = Number(match[1])
        if (item.shell && item.shell.pid !== pid) {
          throw new Error('Shell PID changed')
        }
        if (!item.shell) {
          item.shell = await identify(pid)
          check('shell identity verifiable', Boolean(item.shell?.created))
          owned.shells.push(item.shell)
        } else {
          check(
            'same shell process (pid + creation time)',
            processVerdict(await processTable(), item.shell) === 'live'
          )
        }
        return { shellPid: pid, liveMemoryMatched: true, freshOutputMatched: true }
      }
      await delay(500)
    }
    throw new Error('Live shell nonce/memory verification timed out')
  }
  async function close(item) {
    await cli(session(), env, ['terminal', 'close', '--terminal', item.handle])
    if (item.shell) {
      check('closed terminal shell exited', (await waitVerdict(item.shell, 'exited')) === 'exited')
    }
  }
  // Adding a workspace can open its own fallback terminal; draining means closing every one.
  async function closeAll(worktrees) {
    const remaining = {}
    for (const workspace of Object.values(worktrees)) {
      const listed = await cli(session(), env, ['terminal', 'list', '--worktree', workspace])
      remaining[workspace] = (listed?.terminals ?? []).map((entry) => entry.handle)
      await cli(session(), env, ['terminal', 'close', '--worktree', workspace, '--all'])
    }
    return remaining
  }
  async function seedWorkspaces() {
    const worktrees = {}
    for (const kind of ['git', 'folder']) {
      const path = join(root, kind)
      mkdirSync(path)
      writeFileSync(join(path, 'keep.txt'), 'keep\n')
      let repo
      if (kind === 'git') {
        for (const argv of [
          ['init', '-b', 'main'],
          ['config', 'user.name', 'Orca Test'],
          ['config', 'user.email', 'test@orca.test'],
          ['add', '.'],
          ['commit', '-m', 'seed']
        ]) {
          if ((await runProcess({ program: 'git', args: argv, cwd: path })).code !== 0) {
            throw new Error(`git ${argv[0]} failed`)
          }
        }
        repo = (await cli(session(), env, ['repo', 'add', '--path', path])).repo
      } else {
        const folderEnv = { ...env, ORCA_PAIRING_CODE: session().pairing }
        repo = (await nodeTool(tools.rpc, ['folder', profile, path], folderEnv)).repo
        check(
          'folder stays a folder workspace',
          repo.kind === 'folder' && !existsSync(join(path, '.git'))
        )
      }
      const created = await cli(session(), env, [
        'worktree',
        'create',
        '--repo',
        `id:${repo.id}`,
        '--name',
        `lifecycle-${kind}`,
        '--setup',
        'skip'
      ])
      worktrees[kind] = created.worktree.id
    }
    return worktrees
  }
  return { terminal, observe, close, closeAll, seedWorkspaces }
}
