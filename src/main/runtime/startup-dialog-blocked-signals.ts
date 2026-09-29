import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'

// Why rows: Codex 0.157+ draws `enter continue · esc skip` where older builds wrote `press enter to
// continue`, and the text copy can drop the spaces around `·`. Each row matches by the dialog's
// first `·`, which codex-terminal-readiness.ts would otherwise take for the live chat's footer.
const CODEX_UPDATE_DIALOG_ROW_RE = /^update available\s*·|enter\s*continue\s*·/
const CODEX_HOOKS_REVIEW_KEY_ROW_RE = /enter\s*confirm\s*·/
// Why the key row alone: the retired-model notice's heading comes from the model catalog.
const CODEX_MODEL_NOTICE_KEY_ROW_RE = /enter\/esc\s*continue\s*·/g

function hasDialogRowAfter(
  normalized: string,
  from: number,
  legacyWording: string,
  row: RegExp
): boolean {
  return normalized.includes(legacyWording, from) || row.test(normalized.slice(from))
}

function lastMatchIndex(text: string, row: RegExp): number {
  let index = -1
  for (const match of text.matchAll(row)) {
    index = match.index
  }
  return index
}

// Why together: each startup dialog owns Enter before the chat exists, so a brief typed into one
// answers it (Codex's update dialog defaults to `Update now`).
export function findStartupDialogBlockedSignals(
  normalized: string
): { reason: RuntimeTerminalWaitBlockedReason; index: number }[] {
  const candidates: { reason: RuntimeTerminalWaitBlockedReason; index: number }[] = []
  const updateIndex = normalized.lastIndexOf('update available')
  if (
    updateIndex !== -1 &&
    hasDialogRowAfter(
      normalized,
      updateIndex,
      'press enter to continue',
      CODEX_UPDATE_DIALOG_ROW_RE
    )
  ) {
    candidates.push({ reason: 'agent-update-prompt', index: updateIndex })
  }
  const cwdIndex = normalized.lastIndexOf('choose working directory to')
  if (cwdIndex !== -1 && normalized.includes('press enter to continue', cwdIndex)) {
    candidates.push({ reason: 'agent-cwd-prompt', index: cwdIndex })
  }
  const modelMigrationIndex = normalized.lastIndexOf('codex just got an upgrade')
  if (
    modelMigrationIndex !== -1 &&
    normalized.includes('press enter to continue', modelMigrationIndex)
  ) {
    candidates.push({ reason: 'codex-model-migration-prompt', index: modelMigrationIndex })
  }
  // Why the last: an earlier notice quit with ctrl+c stays in the text copy before a relaunch's header.
  const modelNoticeIndex = lastMatchIndex(normalized, CODEX_MODEL_NOTICE_KEY_ROW_RE)
  if (modelNoticeIndex !== -1) {
    candidates.push({ reason: 'codex-model-migration-prompt', index: modelNoticeIndex })
  }
  // Why the choices: Codex 0.158's announcement heading names the model; its two choices do not change.
  const modelChoiceIndex = normalized.lastIndexOf('try new model')
  if (modelChoiceIndex !== -1 && normalized.includes('use existing model', modelChoiceIndex)) {
    candidates.push({ reason: 'codex-model-migration-prompt', index: modelChoiceIndex })
  }
  const hooksIndex = normalized.lastIndexOf('hooks need review')
  if (
    hooksIndex !== -1 &&
    hasDialogRowAfter(
      normalized,
      hooksIndex,
      'press enter to confirm',
      CODEX_HOOKS_REVIEW_KEY_ROW_RE
    )
  ) {
    // Why neutral: this matcher never inspects the agent -- 'hooks need review' is not Codex-only wording.
    candidates.push({ reason: 'agent-hooks-review-prompt', index: hooksIndex })
  }
  return candidates
}
