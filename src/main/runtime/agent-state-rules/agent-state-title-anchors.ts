import type { AgentStatus } from '../../../shared/agent-detection'
import { isOpenCodeNativeTitle } from '../../../shared/opencode-terminal-title'
import { compileTextTest } from './agent-state-rule-matchers'
import { BUNDLED_AGENT_STATE_RULE_FILES } from './agent-state-rules-catalog'
import type {
  AgentStateRulesFile,
  NamedTitlePredicate,
  TitleAnchorCondition
} from './agent-state-rules-schema'

// Why shared code: the same marker also proves OpenCode presence, so both must read it alike.
const NAMED_TITLE_PREDICATES: Record<NamedTitlePredicate, (title: string) => boolean> = {
  'opencode-native-title': isOpenCodeNativeTitle
}

type TitleAnchorMatcher = (title: string, status: AgentStatus | null) => boolean

function compileTitleAnchor(when: TitleAnchorCondition): TitleAnchorMatcher {
  const matches =
    'predicate' in when.match
      ? NAMED_TITLE_PREDICATES[when.match.predicate]
      : compileTextTest(when.match)
  return (title, status) => status === when.status && matches(title)
}

export function compileTitleAnchors(files: readonly AgentStateRulesFile[]): TitleAnchorMatcher[] {
  return files.flatMap((file) =>
    file.anchors.flatMap(({ when }) => (when.region === 'title' ? [compileTitleAnchor(when)] : []))
  )
}

const TITLE_ANCHORS = compileTitleAnchors(BUNDLED_AGENT_STATE_RULE_FILES)

/** Whether any rule file's title anchor reads `title`, classified `status`, as an agent's own idle. */
export function showsIdleTitleAnchor(title: string, status: AgentStatus | null): boolean {
  return TITLE_ANCHORS.some((matches) => matches(title, status))
}
