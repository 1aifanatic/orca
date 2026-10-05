// The one parser for the live status `interactivePrompt` envelope. Both clients
// read it here, so an envelope this build cannot place is "unsupported" on both:
// shown, never approvable, and never a reason to guess from the agent's prose.

import type { AgentJournalApprovalSubject } from './agent-session-journal-types'
import { parseAskFromStatus, type AskPrompt } from './native-chat-ask'

export type NativeChatDecisionEnvelope =
  | { kind: 'none' }
  | { kind: 'question'; prompt: AskPrompt }
  | { kind: 'approval'; tool: string; summary?: string; subject?: AgentJournalApprovalSubject }
  | { kind: 'unsupported'; text?: string }

const UNSUPPORTED_TEXT_MAX_CHARS = 500
const TEXT_KEYS = ['summary', 'text', 'title'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clip(text: string): string {
  return text.length > UNSUPPORTED_TEXT_MAX_CHARS
    ? `${text.slice(0, UNSUPPORTED_TEXT_MAX_CHARS - 1)}…`
    : text
}

function readRecordText(record: Record<string, unknown>): string | undefined {
  for (const key of TEXT_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }
  const subject = record.subject
  return isRecord(subject) && typeof subject.text === 'string' && subject.text.trim().length > 0
    ? subject.text
    : undefined
}

/** The request's own words for an unplaceable prompt: top level first, then each arm. */
function unsupportedText(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) {
    return undefined
  }
  const candidates = [parsed, ...Object.values(parsed).filter(isRecord)]
  for (const candidate of candidates) {
    const text = readRecordText(candidate)
    if (text) {
      return clip(text)
    }
  }
  return undefined
}

function unsupported(parsed: unknown): NativeChatDecisionEnvelope {
  const text = unsupportedText(parsed)
  return text ? { kind: 'unsupported', text } : { kind: 'unsupported' }
}

/** Closed-set subject reader: a kind this build does not know is not approvable. */
export function readNativeChatApprovalSubject(
  subject: unknown
): AgentJournalApprovalSubject | null {
  if (!isRecord(subject) || subject.kind !== 'plan' || typeof subject.text !== 'string') {
    return null
  }
  if (subject.text.length === 0) {
    return null
  }
  return {
    kind: 'plan',
    text: subject.text,
    ...(typeof subject.filePath === 'string' ? { filePath: subject.filePath } : {})
  }
}

function parseApprovalArm(
  approval: unknown,
  parsed: Record<string, unknown>
): NativeChatDecisionEnvelope {
  if (!isRecord(approval) || typeof approval.tool !== 'string' || approval.tool.length === 0) {
    return unsupported(parsed)
  }
  let subject: AgentJournalApprovalSubject | null = null
  if (approval.subject !== undefined) {
    subject = readNativeChatApprovalSubject(approval.subject)
    if (!subject) {
      return unsupported(parsed)
    }
  }
  const summary =
    typeof approval.summary === 'string' && approval.summary.length > 0
      ? approval.summary
      : undefined
  return {
    kind: 'approval',
    tool: approval.tool,
    ...(summary ? { summary } : {}),
    ...(subject ? { subject } : {})
  }
}

export function parseNativeChatDecisionEnvelope(
  interactivePrompt: string | undefined | null,
  toolName?: string
): NativeChatDecisionEnvelope {
  if (!interactivePrompt || interactivePrompt.trim().length === 0) {
    return { kind: 'none' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(interactivePrompt)
  } catch {
    return { kind: 'unsupported' }
  }
  // Registered question parsers first: a tool's own input shape is not an arm.
  const prompt = parseAskFromStatus(interactivePrompt, toolName)
  if (prompt) {
    return { kind: 'question', prompt }
  }
  if (!isRecord(parsed)) {
    return { kind: 'unsupported' }
  }
  if ('approval' in parsed) {
    return parseApprovalArm(parsed.approval, parsed)
  }
  // A question tool or `questions` arm that did not parse is malformed, not absent.
  return unsupported(parsed)
}
