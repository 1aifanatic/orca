import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_FAILURE_KINDS, isSubmissionRejectionKind } from './agent-session-failure'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_CODEX_QUEUE_FULL,
  DISPATCH_REJECTED_HOST_RESTARTED,
  DISPATCH_REJECTED_NOT_DELIVERED,
  DISPATCH_REJECTED_PROVIDER_CLOSED,
  DISPATCH_REJECTED_QUEUE_FULL,
  DISPATCH_REJECTED_WRITE_FAILED
} from './structured-agent-session-dispatch-rejection'
import {
  structuredAgentSessionSubmissionSettlement,
  type StructuredAgentSessionSubmissionSettlement
} from './structured-agent-session-submission-settlement'

type Shape = Pick<AgentJournalSubmission, 'dispatchState' | 'reason'> &
  Partial<Pick<AgentJournalSubmission, 'recovered' | 'handoverRecorded' | 'handedOverAt'>> & {
    rejection?: unknown
  }

const firstHandRejections: [string, Shape][] = [
  ...AGENT_SESSION_FAILURE_KINDS.filter(isSubmissionRejectionKind)
    .filter((kind) => kind !== 'notDelivered')
    .map((kind): [string, Shape] => [
      `typed ${kind}`,
      { dispatchState: 'rejected', reason: 'The message was not sent.', rejection: { kind } }
    ]),
  ...[
    DISPATCH_REJECTED_CANCELLED,
    DISPATCH_REJECTED_HOST_RESTARTED,
    DISPATCH_REJECTED_PROVIDER_CLOSED,
    DISPATCH_REJECTED_QUEUE_FULL,
    DISPATCH_REJECTED_CODEX_QUEUE_FULL,
    DISPATCH_REJECTED_WRITE_FAILED,
    'Claude does not support .bmp'
  ].map((reason): [string, Shape] => [`legacy ${reason}`, { dispatchState: 'rejected', reason }]),
  [
    'a fact this build cannot place',
    { dispatchState: 'rejected', reason: 'x', rejection: { kind: 'someFutureKind' } }
  ],
  // `recovered` on a rejection says who wrote it, not that it is in doubt.
  [
    'a rejection crash recovery wrote',
    { dispatchState: 'rejected', reason: 'x', rejection: { kind: 'startFailed' }, recovered: true }
  ]
]

const CASES: [string, Shape, StructuredAgentSessionSubmissionSettlement][] = [
  ['pending', { dispatchState: 'pending', reason: null }, 'open'],
  ['queued', { dispatchState: 'pending', reason: null, handoverRecorded: true }, 'open'],
  ['accepted', { dispatchState: 'accepted', reason: null }, 'sent'],
  [
    'live unknown',
    { dispatchState: 'unknown', reason: 'provider_write_outcome_unknown: EPIPE' },
    'open'
  ],
  [
    'recovered unknown (new host)',
    { dispatchState: 'unknown', reason: 'provider_idle_before_acknowledgement', recovered: true },
    'sent'
  ],
  [
    'restart-doubted unknown from a host without `recovered` on the wire (<= v1.4.200)',
    { dispatchState: 'unknown', reason: 'host_restarted_before_acknowledgement' },
    'sent'
  ],
  [
    "an older host's legacy not_delivered",
    { dispatchState: 'rejected', reason: DISPATCH_REJECTED_NOT_DELIVERED },
    'sent'
  ],
  [
    "an older host's typed notDelivered",
    { dispatchState: 'rejected', reason: 'x', rejection: { kind: 'notDelivered' } },
    'sent'
  ],
  ...firstHandRejections.map(
    ([name, shape]): [string, Shape, StructuredAgentSessionSubmissionSettlement] => [
      name,
      shape,
      'refused'
    ]
  )
]

describe('structuredAgentSessionSubmissionSettlement', () => {
  it.each(CASES)('%s', (_name, shape, expected) => {
    expect(structuredAgentSessionSubmissionSettlement(shape)).toBe(expected)
  })

  it('draws a state a newer host wrote as sent, never as nothing', () => {
    // The wire schema admits any dispatch state string.
    const future: Shape = JSON.parse('{"dispatchState":"superseded","reason":null}')
    expect(structuredAgentSessionSubmissionSettlement(future)).toBe('sent')
  })
})
