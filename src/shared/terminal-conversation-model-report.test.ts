import { describe, expect, it } from 'vitest'
import {
  decideConversationModelReport,
  type ConversationModelReport,
  type ConversationModelReportBaseline
} from './terminal-conversation-model-report'

const K = 'conversation-S'

function field(model: string, key: string): ConversationModelReport {
  return { cleared: false, conversationKey: K, model, modelSource: 'field', fieldReportKey: key }
}

function status(model: string, observedFieldKey: string | null = null): ConversationModelReport {
  return {
    cleared: false,
    conversationKey: K,
    model,
    modelSource: 'status',
    fieldReportKey: observedFieldKey
  }
}

const noEvidence: ConversationModelReport = {
  cleared: false,
  conversationKey: null,
  model: null,
  modelSource: null,
  fieldReportKey: null
}

/** Feeds reports in order and returns which ones the picker applied. */
function run(reports: ConversationModelReport[]): boolean[] {
  let baseline: ConversationModelReportBaseline | undefined
  return reports.map((report) => {
    const decision = decideConversationModelReport(baseline, report)
    baseline = decision.baseline
    return decision.apply
  })
}

describe('decideConversationModelReport', () => {
  it('re-delivering the same status model never undoes a pick', () => {
    expect(run([status('Q'), status('Q'), status('Q')])).toEqual([true, false, false])
  })

  it('a field observed beside a status is not a new report when the status goes away', () => {
    expect(run([status('Q', 'P@100'), field('P', 'P@100'), status('Q', 'P@100')])).toEqual([
      true,
      false,
      false
    ])
  })

  it('a no-evidence frame never erases what the picker observed', () => {
    expect(run([status('Q', 'P@100'), noEvidence, field('P', 'P@100')])).toEqual([
      true,
      false,
      false
    ])
  })

  it('applies a field model whose report changed while unusable', () => {
    expect(run([status('Q', 'P@100'), noEvidence, field('P2', 'P2@100')])).toEqual([
      true,
      false,
      true
    ])
  })

  it('seeds an empty picker from the field, then keeps a later status choice', () => {
    expect(run([field('P', 'P@100'), status('Q', 'P@100'), field('P', 'P@100')])).toEqual([
      true,
      true,
      false
    ])
  })

  it('treats a same-clock model change and a clock rollback as new field reports', () => {
    expect(run([field('P', 'P@100'), field('Q', 'Q@100'), field('P', 'P@90')])).toEqual([
      true,
      true,
      true
    ])
  })

  it('resets on a new conversation and on an explicit clear', () => {
    const otherConversation = { ...field('P', 'P@100'), conversationKey: 'conversation-T' }
    const cleared = { ...noEvidence, cleared: true }
    expect(run([field('P', 'P@100'), otherConversation])).toEqual([true, true])
    expect(run([field('P', 'P@100'), cleared, field('P', 'P@100')])).toEqual([true, false, true])
  })

  it('adopts a conversation that first reported with no address without resetting', () => {
    const unaddressed = { ...status('Q'), conversationKey: null }
    expect(run([unaddressed, status('Q')])).toEqual([true, false])
  })
})
