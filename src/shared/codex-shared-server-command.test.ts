import { describe, expect, it } from 'vitest'
import { codexCommandLineJoinsSharedServer } from './codex-shared-server-command'

const NPM_LAUNCHER = 'node /Users/me/.npm-global/lib/node_modules/@openai/codex/bin/codex.js'
const WINDOWS_LAUNCHER =
  '"node"   "C:\\Users\\me\\AppData\\Roaming\\npm\\\\node_modules\\@openai\\codex\\bin\\codex.js"'
const WINDOWS_NATIVE =
  'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe'

describe('codexCommandLineJoinsSharedServer', () => {
  it.each([
    ['bare native codex', 'codex'],
    ['absolute native codex', '/Users/me/.local/bin/codex'],
    ['platform binary', '/opt/codex/codex-aarch64-apple-darwin'],
    ['npm node launcher', NPM_LAUNCHER],
    ['node launcher with node flags', `node --no-warnings ${NPM_LAUNCHER.slice(5)}`],
    ['Windows node launcher with quoted paths', WINDOWS_LAUNCHER],
    ['Windows native child', WINDOWS_NATIVE],
    ['Windows native child with args', `"${WINDOWS_NATIVE}" --model gpt-5`],
    ['resume joins', 'codex resume --last'],
    ['fork joins', 'codex fork'],
    ['agents joins', 'codex agents'],
    ['approval flags keep sharing', 'codex --dangerously-bypass-approvals-and-sandbox'],
    ['model and approval values', 'codex -m gpt-5 -a on-request'],
    ['a prompt', 'codex fix the flaky test'],
    ['launcher args', `${NPM_LAUNCHER} resume --last`]
  ])('%s joins the shared server', (_label, commandLine) => {
    expect(codexCommandLineJoinsSharedServer(commandLine)).toBe(true)
  })

  it.each([
    ['--no-daemon', 'codex --no-daemon'],
    ['--no-daemon through the launcher', `${NPM_LAUNCHER} --no-daemon`],
    ['--no-daemon on Windows', `${WINDOWS_LAUNCHER} --no-daemon`],
    ['--oss', 'codex --oss'],
    ['--remote', 'codex --remote ws://host:1'],
    ['--remote=', 'codex --remote=ws://host:1'],
    ['--profile', 'codex --profile work'],
    ['-p', 'codex -p work'],
    ['-p glued to its value', 'codex -pwork'],
    ['--strict-config', 'codex --strict-config'],
    ['--dangerously-bypass-hook-trust', 'codex --dangerously-bypass-hook-trust'],
    ['--search', 'codex --search'],
    ['--approve-for-me', 'codex --approve-for-me'],
    ['--not-so-yolo', 'codex --not-so-yolo'],
    ['--enable', 'codex --enable worktrees'],
    ['--disable=', 'codex --disable=worktrees'],
    ['-c', 'codex -c model="o3"'],
    ['-c glued', 'codex -cmodel=o3'],
    ['--config', 'codex --config model=o3'],
    ['exec', 'codex exec "summarize"'],
    ['exec alias', 'codex e hi'],
    ['exec after a flag value', 'codex -m gpt-5 exec hi'],
    ['review', 'codex review'],
    ['queue', 'codex queue hi'],
    ['mcp', 'codex mcp list'],
    ['app-server', 'codex app-server --listen unix:// --managed-daemon'],
    [
      'the server Codex spawns on Windows',
      `"\\\\?\\${WINDOWS_NATIVE}" app-server daemon pid-update-loop`
    ],
    ['login', 'codex login'],
    ['logout', 'codex logout'],
    ['apply alias', 'codex a'],
    ['cloud', 'codex cloud'],
    ['completion', 'codex completion zsh'],
    ['features', 'codex features disable daemon_auto_start'],
    ['doctor', 'codex doctor'],
    ['plugin', 'codex plugin list'],
    ['sandbox', 'codex sandbox macos ls'],
    ['debug', 'codex debug models'],
    ['an apostrophe in a prompt before --no-daemon', "codex don't touch tests --no-daemon"],
    ['an apostrophe before a subcommand', "codex it's exec time"],
    ['an apostrophe through the launcher', `${NPM_LAUNCHER} don't break --oss`]
  ])('%s stays off the shared server', (_label, commandLine) => {
    expect(codexCommandLineJoinsSharedServer(commandLine)).toBe(false)
  })

  it.each([
    ['another agent', 'claude'],
    ['a shell', '-zsh'],
    ['node running something else', 'node /srv/app/server.js'],
    ['a prompt that names codex', 'claude "compare codex and claude"'],
    ['an empty line', '']
  ])('%s is not Codex', (_label, commandLine) => {
    expect(codexCommandLineJoinsSharedServer(commandLine)).toBe(false)
  })
})
