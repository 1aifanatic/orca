import { describe, expect, it } from 'vitest'
import { codexStructuredPermissionPolicyForSettings } from './codex-structured-permission-policy'

const BYPASS = { approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user' }
// Approvals on, writes confined to the workspace. Verified against codex 0.153.4: both values are
// accepted on thread/start and thread/resume, and the reply echoes them back as the effective
// policy even when the home's config.toml asks for `never` / `danger-full-access`.
const MANUAL = {
  approvalPolicy: 'on-request',
  sandbox: 'workspace-write',
  approvalsReviewer: 'user'
}

describe('codexStructuredPermissionPolicyForSettings', () => {
  it('bypasses when the user has never opened Agent settings', () => {
    expect(codexStructuredPermissionPolicyForSettings({ agentDefaultArgs: {} })).toEqual(BYPASS)
    expect(codexStructuredPermissionPolicyForSettings({})).toEqual(BYPASS)
    expect(codexStructuredPermissionPolicyForSettings(null)).toEqual(BYPASS)
    expect(
      codexStructuredPermissionPolicyForSettings({ agentDefaultArgs: { claude: '' } })
    ).toEqual(BYPASS)
  })

  it('bypasses when Yolo wrote the flag, alone or beside other tokens', () => {
    for (const codex of [
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-approvals-and-sandbox --model gpt-5.6-sol',
      '--model gpt-5.6-sol --dangerously-bypass-approvals-and-sandbox'
    ]) {
      expect(
        codexStructuredPermissionPolicyForSettings({ agentDefaultArgs: { codex } }),
        codex
      ).toEqual(BYPASS)
    }
  })

  it('keeps quoted mentions and operands after -- in Manual', () => {
    for (const codex of [
      '--config "note=--dangerously-bypass-approvals-and-sandbox only as text"',
      '-- --dangerously-bypass-approvals-and-sandbox'
    ]) {
      expect(
        codexStructuredPermissionPolicyForSettings({ agentDefaultArgs: { codex } }),
        codex
      ).toEqual(MANUAL)
    }
  })

  // Why an explicit policy rather than nothing: the thread-open path spreads this, so nothing
  // means the fields are ABSENT, and absent is not a reset. A session flipped Yolo → Manual
  // resumed with the Yolo thread's `approvalPolicy: never` still in force and escalated with no
  // prompt. Manual has to say what it wants.
  it('states the approval posture when Manual cleared the flag', () => {
    expect(codexStructuredPermissionPolicyForSettings({ agentDefaultArgs: { codex: '' } })).toEqual(
      MANUAL
    )
  })

  it('never answers with an absent policy for either posture', () => {
    for (const codex of ['', '--dangerously-bypass-approvals-and-sandbox', '--model gpt-5.6-sol']) {
      expect(
        codexStructuredPermissionPolicyForSettings({ agentDefaultArgs: { codex } }),
        codex
      ).toBeDefined()
    }
  })

  // A terminal running `codex -s read-only` is read-only; Manual's default would loosen it.
  it('takes the sandbox and approval the Arguments state under Manual', () => {
    expect(
      codexStructuredPermissionPolicyForSettings(
        { agentDefaultArgs: { codex: '-s read-only' } },
        { sandbox: 'read-only' }
      )
    ).toEqual({ ...MANUAL, sandbox: 'read-only' })
    expect(
      codexStructuredPermissionPolicyForSettings(
        { agentDefaultArgs: { codex: '-a untrusted -s danger-full-access' } },
        { approvalPolicy: 'untrusted', sandbox: 'danger-full-access' }
      )
    ).toEqual({ ...MANUAL, approvalPolicy: 'untrusted', sandbox: 'danger-full-access' })
  })

  // A resume keeps the reviewer the thread last ran with unless the request names one, so
  // dropping --approve-for-me has to say `user` out loud.
  it('states the reviewer under Manual: the one the Arguments name, else Codex default', () => {
    expect(
      codexStructuredPermissionPolicyForSettings(
        { agentDefaultArgs: { codex: '--approve-for-me' } },
        { approvalsReviewer: 'auto_review' }
      )
    ).toEqual({ ...MANUAL, approvalsReviewer: 'auto_review' })
    expect(
      codexStructuredPermissionPolicyForSettings({ agentDefaultArgs: { codex: '' } })
        .approvalsReviewer
    ).toBe('user')
  })

  it('keeps Yolo whatever else the Arguments state', () => {
    expect(
      codexStructuredPermissionPolicyForSettings(
        { agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox -s read-only' } },
        { sandbox: 'read-only', approvalsReviewer: 'auto_review' }
      )
    ).toEqual(BYPASS)
  })

  // The posture alone comes out of the field here; the translator reads the stated policy.
  it('carries nothing but the permission posture out of the arguments field', () => {
    expect(
      codexStructuredPermissionPolicyForSettings({
        agentDefaultArgs: {
          codex: '--profile review --add-dir /repo -c model_reasoning_effort=high'
        }
      })
    ).toEqual(MANUAL)
  })
})
