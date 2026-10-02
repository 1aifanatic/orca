import { expect, it } from 'vitest'
import {
  DRAWN_APPROVAL_SUBJECT_KINDS,
  isNewerApprovalSubject
} from './agent-session-approval-subject'
import { AGENT_JOURNAL_APPROVAL_SUBJECT_KINDS } from './agent-session-journal-schemas'

it('draws exactly the subject kinds the journal schema knows', () => {
  expect([...DRAWN_APPROVAL_SUBJECT_KINDS].sort()).toEqual(
    [...AGENT_JOURNAL_APPROVAL_SUBJECT_KINDS].sort()
  )
})

it("reads only a subject of a kind it does not draw as a newer build's", () => {
  expect(isNewerApprovalSubject(undefined)).toBe(false)
  expect(isNewerApprovalSubject({ kind: 'plan' })).toBe(false)
  expect(isNewerApprovalSubject({ kind: 'diff' })).toBe(true)
})
