import { describe, expect, it } from 'vitest'
import { codexAskAnswers } from './native-chat-ask-answers'

function output(answers: Record<string, string[]>): string {
  return JSON.stringify({
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, list]) => [id, { answers: list }])
    )
  })
}

describe('codexAskAnswers', () => {
  it('reads each answer under its question id', () => {
    expect(codexAskAnswers(output({ branch: ['main'], scope: ['Only tests'] }))).toEqual(
      new Map([
        ['branch', ['main']],
        ['scope', ['Only tests']]
      ])
    )
  })

  it('strips the marker Codex puts on text the reader typed', () => {
    expect(codexAskAnswers(output({ scope: ['Only tests', 'user_note: and the docs'] }))).toEqual(
      new Map([['scope', ['Only tests', 'and the docs']]])
    )
  })

  it('keeps the "None of the above" choice beside the text typed in its place', () => {
    expect(
      codexAskAnswers(output({ scope: ['None of the above', 'user_note: just the parser'] }))
    ).toEqual(new Map([['scope', ['None of the above', 'just the parser']]]))
  })

  it('records no answer for a question left unanswered', () => {
    expect(codexAskAnswers(output({ branch: [], scope: ['user_note:  '] }))).toEqual(new Map())
  })

  it('reads nothing from a refusal or an abort, which are plain text', () => {
    expect(codexAskAnswers('request_user_input is unavailable in Default mode')).toBeNull()
    expect(codexAskAnswers('request_user_input can only be used by the root thread')).toBeNull()
    expect(codexAskAnswers('request_user_input was aborted by user after 4.1s')).toBeNull()
  })

  it('reads nothing from JSON of another shape', () => {
    expect(codexAskAnswers('{"output":"ok"}')).toBeNull()
    expect(codexAskAnswers('[1,2]')).toBeNull()
    expect(codexAskAnswers(JSON.stringify({ answers: { a: 'yes' } }))).toEqual(new Map())
  })
})
