/**
 * Gives a plain fish pane Orca's `codex` function without changing how fish
 * starts: the spawn env prepends an Orca data dir to XDG_DATA_DIRS, fish sources
 * that dir's fish/vendor_conf.d, and the snippet's first act is to undo it.
 */
import { getFishCodexShellLaunchPreflight } from '../shared/codex-shell-function'
import type { ShellWrapperFile } from './shell-wrapper-file-writer'

/** Exactly what Orca prepended, so the snippet can remove that and nothing else. */
export const FISH_XDG_DATA_DIRS_PREFIX_ENV = 'ORCA_FISH_XDG_DATA_DIRS_PREFIX'

// Why: the XDG spec default, which fish 4.7+ also scans when XDG_DATA_DIRS is unset or empty.
const XDG_DATA_DIRS_DEFAULT = '/usr/local/share:/usr/share'

export function getFishXdgDataDir(wrapperRoot: string): string {
  return `${wrapperRoot}/fish-xdg-data`
}

export function getFishVendorConfSnippetPath(wrapperRoot: string): string {
  return `${getFishXdgDataDir(wrapperRoot)}/fish/vendor_conf.d/orca-shell-integration.fish`
}

/** Spawn env that makes fish load the snippet; empty when the dir cannot be listed. */
export function getFishXdgDataDirsLaunchEnv(
  wrapperRoot: string,
  inheritedXdgDataDirs: string | undefined
): Record<string, string> {
  const dataDir = getFishXdgDataDir(wrapperRoot)
  if (dataDir.includes(':')) {
    return {}
  }
  const prefix = inheritedXdgDataDirs ? dataDir : `${dataDir}:${XDG_DATA_DIRS_DEFAULT}`
  return {
    XDG_DATA_DIRS: inheritedXdgDataDirs ? `${prefix}:${inheritedXdgDataDirs}` : prefix,
    [FISH_XDG_DATA_DIRS_PREFIX_ENV]: prefix
  }
}

/** Node twin of the snippet's restore, for a fish launch that fell back to another shell. */
export function restoreFishXdgDataDirs(env: Record<string, string>): void {
  const prefix = env[FISH_XDG_DATA_DIRS_PREFIX_ENV]
  if (prefix === undefined) {
    return
  }
  delete env[FISH_XDG_DATA_DIRS_PREFIX_ENV]
  const rest = `:${env.XDG_DATA_DIRS ?? ''}:`.replace(`:${prefix}:`, ':').slice(1, -1)
  if (rest) {
    env.XDG_DATA_DIRS = rest
  } else {
    delete env.XDG_DATA_DIRS
  }
}

// Why a function: its variables stay function-scoped, so nothing but the
// restored XDG_DATA_DIRS and the codex hook outlives this file.
// Why the vendor-dir cleanup: fish derived its search paths from the prefixed
// value before any snippet ran, so restoring the env var alone leaves Orca's dir
// in them. Why codex waits for fish_prompt: config.fish has not run yet, and the
// user's own codex function or PATH entry must be seen first, as in wrapped panes.
export function getFishVendorConfSnippet(): string {
  return `# Orca-generated. Loaded only because Orca put this directory on
# XDG_DATA_DIRS for one fish launch; the first thing it does is take it off.
function __orca_fish_xdg_handoff
    set -q ${FISH_XDG_DATA_DIRS_PREFIX_ENV}; or return 0
    set -l prefix "$${FISH_XDG_DATA_DIRS_PREFIX_ENV}"
    set -e -g ${FISH_XDG_DATA_DIRS_PREFIX_ENV}
    set -l dirs (string join : -- $XDG_DATA_DIRS)
    set dirs (string replace -- ":$prefix:" : ":$dirs:")
    set dirs (string replace -r -a -- '^:|:$' '' "$dirs")
    if test -n "$dirs"
        set -gx XDG_DATA_DIRS "$dirs"
    else
        set -e -g XDG_DATA_DIRS
    end

    set -l orca_fish_dir (string split -m 1 : -- $prefix)[1]/fish
    for var in __fish_vendor_confdirs __fish_vendor_functionsdirs __fish_vendor_completionsdirs fish_function_path fish_complete_path
        for sub in vendor_conf.d vendor_functions.d vendor_completions.d
            while set -l index (contains -i -- $orca_fish_dir/$sub $$var)
                set -e $var"[$index]"
            end
        end
    end

    status is-interactive; or return 0
    function __orca_define_codex --on-event fish_prompt
        functions -e __orca_define_codex
${getFishCodexShellLaunchPreflight()}
    end
end
__orca_fish_xdg_handoff
functions -e __orca_fish_xdg_handoff
`
}

export function buildFishVendorConfWrapperFile(wrapperRoot: string): ShellWrapperFile {
  return [getFishVendorConfSnippetPath(wrapperRoot), getFishVendorConfSnippet()]
}
