import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { CLAUDE_PROFILE_HISTORY_DIRS } from './claude-profile-history'
import { CLAUDE_PROFILE_RESOURCE_DIRS } from './claude-profile-provisioning'
import { parseClaudeCliVersion } from '../claude/claude-hook-event-versions'
import { getAppEnvironment } from '../../shared/app-environment'
import { runProcess } from '../../shared/child-process/run-process'
import {
  buildWslExecArgs,
  buildWslCapturedLoginShellCommand
} from '../../shared/wsl-login-shell-command'
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import { relayBundleCandidates } from '../ssh/relay-bundle-paths'
import { filterPathsToRunningWslDistrosAsync } from '../wsl-running-path-filter'
import { ensureWslPinnedRuntime, type WslRuntimeCommand } from '../wsl/wsl-pinned-runtime'
import { runWslProcess } from '../wsl/wsl-runner'
import { resolveWslExecutablePath } from '../wsl/wsl-executable-path'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import type { ClaudeWslProfileRequest } from './claude-profile-wsl-guest'

const responseSchema = z.object({
  ready: z.boolean(),
  provisioned: z.boolean(),
  homes: z.array(z.string().startsWith('/')).optional(),
  historyHomes: z
    .object({
      projects: z.array(z.string().startsWith('/')),
      transcripts: z.array(z.string().startsWith('/'))
    })
    .optional(),
  report: z
    .object({
      outcome: z.enum(['prepared', 'refused']),
      surfaces: z.record(
        z.string(),
        z.enum(['linked', 'synced', 'merged', 'unchanged', 'user-owned', 'absent', 'failed'])
      ),
      warnings: z.array(
        z.object({
          surface: z.enum([
            'profile',
            ...CLAUDE_PROFILE_HISTORY_DIRS,
            ...CLAUDE_PROFILE_RESOURCE_DIRS,
            'history.jsonl',
            'CLAUDE.md',
            'settings.json',
            '.claude.json',
            'ledger',
            'hooks'
          ]),
          code: z.enum([
            'invalid-profile',
            'unreadable',
            'locked',
            'trust-refused',
            'cross-filesystem',
            'retained-conflict',
            'link-failed',
            'failed'
          ]),
          detail: z.string()
        })
      )
    })
    .optional()
})
export type ClaudeWslProfileResponse = z.infer<typeof responseSchema>
export type ClaudeWslGuest = {
  home: string
  request: (request: ClaudeWslProfileRequest) => Promise<ClaudeWslProfileResponse>
}

export async function prepareClaudeWslGuest(distro: string): Promise<ClaudeWslGuest> {
  const app = getAppEnvironment()
  const bundle = (['linux-x64', 'linux-arm64'] as const)
    .flatMap((platform) => relayBundleCandidates(platform, app.getAppPath()))
    .map((root) => join(root, 'claude-profile-wsl.cjs'))
    .find(existsSync)
  if (!bundle) {
    throw new Error('The bundled WSL Claude profile helper is missing. Reinstall Orca.')
  }
  const signal = AbortSignal.timeout(180_000)
  const checkRunning = async () => {
    const paths = await filterPathsToRunningWslDistrosAsync([toWindowsWslUncPath('/', distro)], {
      requireConfirmed: true
    })
    if (!paths.length) {
      throw new Error(
        `WSL distro ${distro} is not running. Start it before choosing a Claude account.`
      )
    }
  }
  const run: WslRuntimeCommand = async (spec, timeoutMs = 15_000) => {
    signal.throwIfAborted()
    await checkRunning()
    const result = await runWslProcess({ ...spec, distro, timeoutMs, maxOutputBytes: 256 * 1024 })
    if (result.code !== 0 || result.timedOut) {
      throw new Error(
        `WSL Claude profile setup failed: ${result.stderr || 'guest command unavailable'}`
      )
    }
    return result.stdout.trim()
  }
  const runtime = await ensureWslPinnedRuntime(
    run,
    join(app.getPath('userData'), 'orcad-artifacts'),
    signal
  )
  const guestBundle = await run({
    program: 'wslpath',
    args: ['-a', '-u', bundle],
    loginPath: 'none'
  })
  if (!guestBundle.startsWith('/') || /[\r\n\0]/.test(guestBundle)) {
    throw new Error('WSL helper path is invalid')
  }
  return {
    home: runtime.home,
    request: async (request) => {
      await checkRunning()
      // Resolve Claude's version through the guest login environment only when installing hooks.
      let claudeVersion = request.claudeVersion
      if (request.action === 'setup' && request.hooksEnabled) {
        const capture = buildWslCapturedLoginShellCommand('claude --version')
        const output = await run({
          program: '/bin/sh',
          args: ['-c', capture.command],
          loginPath: 'none'
        })
        claudeVersion = parseClaudeCliVersion(capture.readStdout(output) ?? '') ?? undefined
      }
      await checkRunning()
      const result = await runProcess({
        program: resolveWslExecutablePath(),
        args: buildWslExecArgs(distro, [
          '/usr/bin/env',
          '-u',
          'NODE_OPTIONS',
          runtime.executable,
          guestBundle
        ]),
        input: JSON.stringify({ ...request, claudeVersion }),
        cwd: resolveWslInteropSpawnCwd(),
        timeoutMs: 120_000,
        maxOutputBytes: 256 * 1024
      })
      if (result.code !== 0 || result.timedOut) {
        throw new Error(
          `WSL Claude profile refused: ${result.stderr || 'guest runtime unavailable'}`
        )
      }
      return responseSchema.parse(JSON.parse(result.stdout))
    }
  }
}

/** Withdrawing selection must still work when the pinned runtime is missing. */
export async function withdrawClaudeWslPointer(distro: string): Promise<void> {
  const paths = await filterPathsToRunningWslDistrosAsync([toWindowsWslUncPath('/', distro)], {
    requireConfirmed: true
  })
  if (!paths.length) {
    throw new Error(`WSL distro ${distro} is not running; its pointer could not be withdrawn`)
  }
  const result = await runWslProcess({
    distro,
    loginPath: 'none',
    script: 'rm -f -- "$HOME/.local/share/orca/claude-profiles/selected-wsl"',
    timeoutMs: 5_000
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error('WSL Claude account pointer could not be withdrawn')
  }
}
