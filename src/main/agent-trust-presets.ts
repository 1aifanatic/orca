import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomically } from './codex-accounts/fs-utils'
import { getOrcaManagedCodexHomePath } from './codex/codex-home-paths'
import { runExclusivelyForCodexTrustConfig } from './codex/codex-trust-config-mutation-queue'
import {
  canonicalizeTrustPath,
  resolveCodexProjectTrustRoot,
  settleCodexProjectTrust,
  writeCodexProjectTrust
} from './codex/codex-project-trust-write'

export type AgentTrustPreset = 'cursor' | 'copilot' | 'codex' | 'antigravity' | 'qoder'

/**
 * Pre-mark a workspace as trusted for cursor-agent, GitHub Copilot CLI, or
 * Codex so the agent's "Do you trust this folder?" menu does not fire on
 * first launch.
 *
 * Why: Orca's "drop URL into agent input as a draft" flow injects the URL
 * via bracketed-paste once the TUI is up. If the trust menu intercepts the
 * keystrokes (each menu reads a single character or numbered option), the
 * paste either selects an arbitrary option or quits the session. Pre-writing
 * the same trust artifacts that the agent writes after the user accepts is
 * the only documented bypass — both CLIs read these files at startup before
 * showing the menu.
 *
 * Side note: a `--trust`-style CLI flag exists in cursor-agent but only
 * applies in `--print/headless` mode (per its --help). Copilot has no
 * documented flag at all (verified against @github/copilot 1.0.32 bundle).
 * Codex's `--dangerously-bypass-approvals-and-sandbox` would also change
 * approval/sandbox policy, so it is not equivalent to "trust this project".
 */

/**
 * Cursor's CLI keeps a per-workspace trust marker at:
 *   ~/.cursor/projects/<slug>/.workspace-trusted
 * where <slug> is the absolute path with the leading `/` stripped and
 * remaining `/` replaced with `-`. The file payload is `{ trustedAt,
 * workspacePath }`. Verified against the cursor-agent CLI bundle
 * (versions/2026.04.17-787b533/index.ts: `_=".workspace-trusted"`, slug
 * derived via the same util that resolves `~/.cursor/projects/<slug>`).
 */
export function markCursorWorkspaceTrusted(workspacePath: string): void {
  const absPath = canonicalizeTrustPath(workspacePath)
  const slug = cursorWorkspaceSlug(absPath)
  if (!slug) {
    return
  }
  const trustDir = join(homedir(), '.cursor', 'projects', slug)
  const trustFile = join(trustDir, '.workspace-trusted')
  if (existsSync(trustFile)) {
    return
  }
  mkdirSync(trustDir, { recursive: true })
  const payload = JSON.stringify(
    { trustedAt: new Date().toISOString(), workspacePath: absPath },
    null,
    2
  )
  writeFileAtomically(trustFile, `${payload}\n`)
}

/**
 * GitHub Copilot CLI keeps a global list of trusted folders in
 * ~/.copilot/config.json under `trustedFolders` (verified against the
 * @github/copilot 1.0.32 bundle: `addTrustedFolder` and `isFolderTrusted`
 * both read/write this exact key, and folder comparison is done after a
 * realpath() resolution).
 *
 * We append to the array in-place so unrelated config keys (loggedInUsers,
 * copilotTokens, etc.) survive untouched.
 */
export function markCopilotFolderTrusted(workspacePath: string): void {
  const absPath = canonicalizeTrustPath(workspacePath)
  const configDir = join(homedir(), '.copilot')
  const configPath = join(configDir, 'config.json')
  let config: Record<string, unknown> = {}
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = Object.fromEntries(Object.entries(parsed))
      }
    }
  } catch {
    // Why: a corrupted config.json is the user's to fix — refuse to overwrite
    // it from this side-effect path. Copilot will rewrite the file itself
    // after the user accepts the trust prompt manually.
    return
  }
  const existing = Array.isArray(config.trustedFolders) ? (config.trustedFolders as unknown[]) : []
  const normalizedExisting = existing.map((entry) =>
    typeof entry === 'string' ? canonicalizeTrustPath(entry) : null
  )
  if (normalizedExisting.includes(absPath)) {
    return
  }
  const next = [...existing.filter((e) => typeof e === 'string'), absPath]
  config.trustedFolders = next
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }
  writeFileAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

/**
 * The Antigravity CLI (agy) keeps its trusted workspaces in
 * ~/.gemini/antigravity-cli/settings.json under `trustedWorkspaces`, a flat
 * array of absolute paths in native OS form.
 *
 * Verified empirically against agy 1.2.7 on Windows: accepting the CLI's
 * "Do you trust the contents of this project?" prompt for a freshly created
 * worktree appended exactly that worktree's path to this array. Note this is
 * NOT ~/.gemini/trustedFolders.json — that file belongs to the Gemini CLI and
 * agy does not consult it.
 *
 * Trust is exact-path and NOT inherited by subdirectories: `C:\Users\<you>`
 * was already present in the array, yet launching agy in a descendant still
 * raised the prompt and appended the descendant separately. Every new child
 * worktree therefore needs its own entry, which is precisely what this
 * per-worktree preflight provides.
 *
 * We append in-place so the sibling keys in the same file (model, permissions,
 * toolPermission, agentMode, …) survive untouched.
 */
export function markAntigravityWorkspaceTrusted(workspacePath: string): void {
  const absPath = canonicalizeTrustPath(workspacePath)
  const configDir = join(homedir(), '.gemini', 'antigravity-cli')
  const configPath = join(configDir, 'settings.json')
  let config: Record<string, unknown> = {}
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        config = parsed as Record<string, unknown>
      }
    }
  } catch {
    // Why: a corrupted settings.json is the user's to fix — refuse to
    // overwrite it from this side-effect path. agy rewrites the file itself
    // once the user accepts the trust prompt manually.
    return
  }
  const existing = Array.isArray(config.trustedWorkspaces) ? config.trustedWorkspaces : []
  const normalizedExisting = existing.map((entry) =>
    typeof entry === 'string' ? canonicalizeTrustPath(entry) : null
  )
  if (normalizedExisting.includes(absPath)) {
    return
  }
  config.trustedWorkspaces = [...existing.filter((e) => typeof e === 'string'), absPath]
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }
  writeFileAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

/**
 * Codex stores project trust in ~/.codex/config.toml under:
 *   [projects."<realpath>"]
 *   trust_level = "trusted"
 *
 * Verified against codex-rs/tui/src/onboarding/trust_directory.rs and
 * codex-rs/core/src/config/config_tests.rs in the Codex CLI source.
 */
export async function markCodexProjectTrusted(workspacePath: string): Promise<void> {
  const trustRoot = resolveCodexProjectTrustRoot(workspacePath)
  const systemTomlPath = join(homedir(), '.codex', 'config.toml')
  // Why: Orca-launched Codex runs with an Orca-owned CODEX_HOME, so the trust
  // preset must also update the runtime config Codex will actually read.
  const runtimeTomlPath = join(getOrcaManagedCodexHomePath(), 'config.toml')
  // Why (#16441): hook installs now await a codex app-server grant, so an
  // unqueued write here can land inside their capture->restore window and be
  // reverted. Same runtime-before-system lock order the installer takes.
  const results = await runExclusivelyForCodexTrustConfig(runtimeTomlPath, () =>
    runExclusivelyForCodexTrustConfig(systemTomlPath, async () => [
      // Why (#23847): each home is written on its own, so a read-only or broken ~/.codex no longer skips the runtime home.
      writeCodexProjectTrust(systemTomlPath, trustRoot),
      writeCodexProjectTrust(runtimeTomlPath, trustRoot)
    ])
  )
  settleCodexProjectTrust(workspacePath, results)
}

function cursorWorkspaceSlug(absPath: string): string {
  const stripped = absPath.replace(/^[\\/]+/, '')
  // Why: Windows absolute paths include characters such as ":" that cannot
  // be used in the ~/.cursor/projects/<slug> directory name.
  const slug = stripped.replace(/[\\/:*?"<>|]+/g, '-')
  return slug
}
