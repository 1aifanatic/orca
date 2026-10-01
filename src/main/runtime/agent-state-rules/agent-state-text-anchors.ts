import type { RuntimeTerminalWaitBlockedReason } from '../../../shared/runtime-types'
import { startOfLastLines } from '../terminal-wait-tail-window'
import { compileTextTest, type TextMatcher } from './agent-state-rule-matchers'
import { BUNDLED_AGENT_STATE_RULE_FILES } from './agent-state-rules-catalog'
import type { AgentStateRulesFile, NamedTextAnchor, TextAnchor } from './agent-state-rules-schema'
import { findAntigravityComposerIndex } from './antigravity-text-composer'

export type BlockedTextSignal = { reason: RuntimeTerminalWaitBlockedReason; index: number }

/** Where a live prompt starts, and whether the text after it says the agent is busy. */
type PromptAnchorHit = { index: number; working: boolean }

const NAMED_TEXT_ANCHOR_FINDERS: Record<NamedTextAnchor, (normalized: string) => number | null> = {
  'antigravity-text-composer': findAntigravityComposerIndex
}

type BlockedAnchor = Extract<TextAnchor, { state: 'blocked' }>
type PromptAnchor = Extract<TextAnchor, { state: 'idle' }>

function compileBlockedAnchor(anchor: BlockedAnchor): (window: string) => BlockedTextSignal | null {
  const hasChoices = anchor.lines ? compileLineCount(anchor.lines) : null
  return (window) => {
    const start = anchor.withinLastLines ? startOfLastLines(window, anchor.withinLastLines) : 0
    const tail = window.slice(start)
    const at = tail.lastIndexOf(anchor.lastOf)
    if (at === -1 || (hasChoices && !hasChoices(tail))) {
      return null
    }
    return { reason: anchor.reason, index: start + at }
  }
}

function compileLineCount(lines: NonNullable<BlockedAnchor['lines']>): TextMatcher {
  const test = compileTextTest(lines.test)
  return (tail) => {
    const rows = tail.split('\n')
    while (rows.length > 0 && rows.at(-1)?.trim() === '') {
      rows.pop()
    }
    return (
      rows.filter(test).length >= lines.atLeast && (!lines.includingLast || test(rows.at(-1) ?? ''))
    )
  }
}

function compilePromptAnchor(anchor: PromptAnchor): (normalized: string) => PromptAnchorHit | null {
  const find = anchor.find
  const workingIfAfter = anchor.workingIfAfter ? compileTextTest(anchor.workingIfAfter) : null
  const findIndex =
    'predicate' in find
      ? NAMED_TEXT_ANCHOR_FINDERS[find.predicate]
      : (normalized: string): number | null => {
          const index = normalized.lastIndexOf(find.lastOf)
          if (index === -1) {
            return null
          }
          return !find.followedBy || normalized.includes(find.followedBy, index) ? index : null
        }
  return (normalized) => {
    const index = findIndex(normalized)
    if (index === null) {
      return null
    }
    return { index, working: workingIfAfter?.(normalized.slice(index)) ?? false }
  }
}

export function compileTextAnchors(files: readonly AgentStateRulesFile[]): {
  blocked: ((window: string) => BlockedTextSignal | null)[]
  prompts: ((normalized: string) => PromptAnchorHit | null)[]
  blockedLiterals: string[]
  screenProbeBanners: string[]
} {
  const anchors = files.flatMap((file) => file.textAnchors)
  const blockedAnchors = anchors.filter((anchor) => anchor.state === 'blocked')
  return {
    blocked: blockedAnchors.map(compileBlockedAnchor),
    prompts: anchors.filter((anchor) => anchor.state === 'idle').map(compilePromptAnchor),
    blockedLiterals: blockedAnchors.map((anchor) => anchor.lastOf),
    screenProbeBanners: files.flatMap((file) => file.screenProbeBanner ?? [])
  }
}

const TEXT_ANCHORS = compileTextAnchors(BUNDLED_AGENT_STATE_RULE_FILES)

/** The literal every blocked anchor needs, for the blocked layer's one-pass prefilter. */
export const BLOCKED_ANCHOR_LITERALS: readonly string[] = TEXT_ANCHORS.blockedLiterals

/** Every rule file's blocked anchor found in the blocked layer's live window. */
export function findBlockedAnchorSignals(window: string): BlockedTextSignal[] {
  return TEXT_ANCHORS.blocked.flatMap((find) => find(window) ?? [])
}

/**
 * The latest live prompt (`live`, idle or busy: it proves an earlier startup dialog was answered)
 * and the latest idle one (`ready`) that any rule file's anchors find in the text tail.
 */
export function findPromptAnchorIndexes(normalized: string): {
  live: number | null
  ready: number | null
} {
  let live: number | null = null
  let ready: number | null = null
  for (const find of TEXT_ANCHORS.prompts) {
    const hit = find(normalized)
    if (hit === null) {
      continue
    }
    live = Math.max(live ?? -1, hit.index)
    if (!hit.working) {
      ready = Math.max(ready ?? -1, hit.index)
    }
  }
  return { live, ready }
}

export function showsScreenProbeBanner(text: string): boolean {
  if (TEXT_ANCHORS.screenProbeBanners.length === 0) {
    return false
  }
  const normalized = text.toLowerCase()
  return TEXT_ANCHORS.screenProbeBanners.some((banner) => normalized.includes(banner))
}
