import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { CLAUDE_PROFILE_HISTORY_DIRS } from './claude-profile-history'
import { CLAUDE_PROFILE_RESOURCE_DIRS } from './claude-profile-provisioning'
import { parseClaudeCliVersion } from '../claude/claude-hook-event-versions'
import { getAppEnvironment } from '../../shared/app-environment'
import { buildWslCapturedLoginShellCommand } from '../../shared/wsl-login-shell-command'
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import { WSL_CLAUDE_PROFILE_POINTER_FROM_HOME } from '../../shared/claude-profile-routing'
import { filterPathsToRunningWslDistrosAsync } from '../wsl-running-path-filter'
import { ensureWslPinnedRuntime } from '../wsl/wsl-pinned-runtime'
import { wslRelayBundleDirs } from '../wsl/wsl-relay-bundle-dirs'
import { runWslProcess, type WslSpec } from '../wsl/wsl-runner'
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

const PREPARE_TIMEOUT_MS = 180_000
// Why a window: one prepare runs several guest commands back to back; a long download re-checks.
const RUNNING_CONFIRMATION_MS = 10_000

export async function prepareClaudeWslGuest(distro: string): Promise<ClaudeWslGuest> {
  const app = getAppEnvironment()
  const bundle = wslRelayBundleDirs()
    .map((root) => join(root, 'claude-profile-wsl.cjs'))
    .find(existsSync)
  if (!bundle) {
    throw new Error('The bundled WSL Claude profile helper is missing. Reinstall Orca.')
  }
  const run = async (spec: WslSpec, timeoutMs = 15_000): Promise<string> => {
    const result = await runWslProcess({ ...spec, distro, timeoutMs, maxOutputBytes: 256 * 1024 })
    if (result.code !== 0 || result.timedOut) {
      throw new Error(
        `WSL Claude profile setup failed: ${result.stderr.trim() || 'guest command unavailable'}`
      )
    }
    return result.stdout.trim()
  }
  // Why per operation: a cached guest outlives this deadline, so requests never inherit it.
  const signal = AbortSignal.timeout(PREPARE_TIMEOUT_MS)
  let confirmedAt = Number.NEGATIVE_INFINITY
  const runPreparing = async (spec: WslSpec, timeoutMs?: number) => {
    signal.throwIfAborted()
    if (Date.now() - confirmedAt > RUNNING_CONFIRMATION_MS) {
      await requireRunningWslDistro(distro)
      confirmedAt = Date.now()
    }
    return run(spec, timeoutMs)
  }
  const runtime = await ensureWslPinnedRuntime(
    runPreparing,
    join(app.getPath('userData'), 'orcad-artifacts'),
    signal,
    'Claude profile helper'
  )
  const guestBundle = await runPreparing({
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
      await requireRunningWslDistro(distro)
      let claudeVersion = request.claudeVersion
      if (request.action === 'setup' && request.hooksEnabled) {
        // Why caught: like native setup, an unknown version installs the default hook plan.
        try {
          const capture = buildWslCapturedLoginShellCommand('claude --version')
          const output = await run({
            program: '/bin/sh',
            args: ['-c', capture.command],
            loginPath: 'none'
          })
          claudeVersion = parseClaudeCliVersion(capture.readStdout(output) ?? '') ?? undefined
        } catch (error) {
          console.warn('[claude-profile] WSL Claude version probe failed:', error)
        }
      }
      const result = await runWslProcess({
        program: '/usr/bin/env',
        args: ['-u', 'NODE_OPTIONS', runtime.executable, guestBundle],
        input: JSON.stringify({ ...request, claudeVersion }),
        distro,
        loginPath: 'none',
        timeoutMs: 120_000,
        maxOutputBytes: 256 * 1024
      })
      if (result.code !== 0 || result.timedOut) {
        throw new Error(
          `WSL Claude profile refused: ${result.stderr.trim() || 'guest runtime unavailable'}`
        )
      }
      return responseSchema.parse(JSON.parse(result.stdout))
    }
  }
}

async function requireRunningWslDistro(distro: string): Promise<void> {
  const paths = await filterPathsToRunningWslDistrosAsync([toWindowsWslUncPath('/', distro)], {
    requireConfirmed: true
  })
  if (!paths.length) {
    throw new Error(
      `WSL distro ${distro} is not running. Start it before choosing a Claude account.`
    )
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
    script: `rm -f -- "$HOME/${WSL_CLAUDE_PROFILE_POINTER_FROM_HOME}"`,
    timeoutMs: 5_000
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error('WSL Claude account pointer could not be withdrawn')
  }
}
